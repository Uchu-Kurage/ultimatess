// ============================================================================
// §7.4 受け入れテスト — 安全な移動パイプライン。
// すべて実 fs（一時ディレクトリ）+ InMemoryStore で動作し、ネイティブ依存なし。
// ============================================================================

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { InMemoryStore } from '../app/core/store/inMemoryStore.js';
import { RestructureEngine } from '../app/core/organize/restructure.js';
import { DEFAULT_NAMING_RULE } from '../app/shared/types.js';
import {
  exists,
  makeFileOp,
  read,
  seedMedia,
  TestTrash,
  tmpDir,
  writeFile,
} from './helpers.js';

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) {
    const d = cleanups.pop()!;
    await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

async function scratch(): Promise<{ src: string; target: string; trash: TestTrash }> {
  const base = await tmpDir();
  cleanups.push(base);
  const src = path.join(base, 'source');
  const target = path.join(base, 'library');
  const trash = new TestTrash(path.join(base, 'trash'));
  await fs.mkdir(src, { recursive: true });
  await fs.mkdir(target, { recursive: true });
  return { src, target, trash };
}

describe('同一ドライブ 大量 rename の整合', () => {
  it('全ファイルが target へ移動し、source は消え、source_ref が更新される', async () => {
    const { src, target, trash } = await scratch();
    const store = new InMemoryStore();
    const N = 50;
    const files = Array.from({ length: N }, (_, i) => ({
      path: path.join(src, `IMG_${i}.jpg`),
      content: `photo-${i}`,
      createdAt: Date.UTC(2024, 7, 15, 9, 30, i % 60),
    }));
    const { media } = await seedMedia(store, src, files);

    const fileop = makeFileOp(trash); // 同一 fs => sameVolume true
    const engine = new RestructureEngine(store, fileop);
    const plan = await engine.proposeRestructure(target, DEFAULT_NAMING_RULE);
    expect(plan.items.length).toBe(N);
    expect(plan.items.every((i) => i.sameDrive)).toBe(true);

    let lastDone = 0;
    await engine.applyRestructure(plan.id, (d) => (lastDone = d));
    expect(lastDone).toBe(N);

    for (let i = 0; i < N; i++) {
      expect(await exists(files[i].path)).toBe(false); // 原本位置は空
      const m = store.getMedia(media[i].id)!;
      expect(m.sourceRef.startsWith(target)).toBe(true);
      expect(await exists(m.sourceRef)).toBe(true);
      expect(await read(m.sourceRef)).toBe(`photo-${i}`);
    }
    expect(store.getRestructurePlan(plan.id)!.status).toBe('done');
    expect(trash.count()).toBe(0); // 同一ドライブはゴミ箱を使わない
  });
});

describe('ドライブ跨ぎ copy→verify→trash の整合', () => {
  it('コピー後に検証し、原本をゴミ箱へ送る', async () => {
    const { src, target, trash } = await scratch();
    const store = new InMemoryStore();
    const { media } = await seedMedia(store, src, [
      { path: path.join(src, 'a.jpg'), content: 'AAA' },
      { path: path.join(src, 'b.jpg'), content: 'BBB' },
    ]);
    // sameVolume を強制的に false にしてドライブ跨ぎ経路を通す。
    const fileop = makeFileOp(trash, { sameVolume: () => false });
    const engine = new RestructureEngine(store, fileop);
    const plan = await engine.proposeRestructure(target, DEFAULT_NAMING_RULE);
    expect(plan.items.every((i) => !i.sameDrive)).toBe(true);
    expect(plan.spaceRequired).toBe(6); // 'AAA'+'BBB'

    await engine.applyRestructure(plan.id);

    for (const m0 of media) {
      const m = store.getMedia(m0.id)!;
      expect(m.sourceRef.startsWith(target)).toBe(true);
      expect(await exists(m.sourceRef)).toBe(true);
      expect(await exists(m0.sourceRef)).toBe(false); // 原本はゴミ箱へ
    }
    expect(trash.count()).toBe(2);
    // 各 item に checksum が記録されている。
    for (const it of store.listRestructureItems(plan.id)) {
      expect(it.state).toBe('done');
      expect(it.checksum).toBeTruthy();
    }
  });
});

describe('クラッシュ耐性: コピー途中で強制終了 → 再起動で二重コピー/データ欠損なし', () => {
  it('state=pending + 残留 .part から recoverOnStartup で正しく完了', async () => {
    const { src, target, trash } = await scratch();
    const store = new InMemoryStore();
    const { media } = await seedMedia(store, src, [
      { path: path.join(src, 'a.jpg'), content: 'HELLO-WORLD' },
    ]);
    const fileop = makeFileOp(trash, { sameVolume: () => false });
    const engine = new RestructureEngine(store, fileop);
    const plan = await engine.proposeRestructure(target, DEFAULT_NAMING_RULE);
    const item = store.listRestructureItems(plan.id)[0];

    // --- クラッシュ状態を再現: plan=running, item=pending, 壊れた .part が残留 ---
    store.updateRestructurePlanStatus(plan.id, 'running');
    await writeFile(`${item.toPath}.part`, 'GARBAGE-PARTIAL');

    // 再起動相当。
    await engine.recoverOnStartup();

    const m = store.getMedia(media[0].id)!;
    expect(m.sourceRef).toBe(item.toPath);
    expect(await read(item.toPath)).toBe('HELLO-WORLD'); // 完全なデータ
    expect(await exists(`${item.toPath}.part`)).toBe(false); // 残骸なし
    expect(await exists(item.fromPath)).toBe(false); // 原本はゴミ箱
    expect(trash.count()).toBe(1); // 二重にゴミ箱送りされない
    expect(store.getRestructurePlan(plan.id)!.status).toBe('done');
  });

  it('中間 state からの再開（copied / verified / source_trashed）', async () => {
    for (const startState of ['copied', 'verified', 'source_trashed'] as const) {
      const { src, target, trash } = await scratch();
      const store = new InMemoryStore();
      await seedMedia(store, src, [{ path: path.join(src, 'x.jpg'), content: 'DATA' }]);
      const fileop = makeFileOp(trash, { sameVolume: () => false });
      const engine = new RestructureEngine(store, fileop);
      const plan = await engine.proposeRestructure(target, DEFAULT_NAMING_RULE);
      const item = store.listRestructureItems(plan.id)[0];

      // それぞれの中間状態を手で作り出す。
      await fs.mkdir(path.dirname(item.toPath), { recursive: true });
      await fs.copyFile(item.fromPath, item.toPath); // copy 済み
      store.updateRestructurePlanStatus(plan.id, 'running');
      if (startState === 'copied') {
        store.updateRestructureItem(plan.id, item.mediaId, { state: 'copied' });
      } else if (startState === 'verified') {
        store.updateRestructureItem(plan.id, item.mediaId, { state: 'verified', checksum: 'x' });
      } else {
        // source_trashed: 原本は既にゴミ箱へ。
        await trash.trash(item.fromPath);
        store.updateRestructureItem(plan.id, item.mediaId, { state: 'source_trashed' });
      }

      await engine.recoverOnStartup();

      expect(await read(item.toPath), startState).toBe('DATA');
      expect(await exists(item.fromPath), startState).toBe(false);
      expect(store.getRestructurePlan(plan.id)!.status, startState).toBe('done');
    }
  });
});

describe('checksum 不一致時に原本が消えない', () => {
  it('検証失敗した item は failed、原本は保全される', async () => {
    const { src, target, trash } = await scratch();
    const store = new InMemoryStore();
    const { media } = await seedMedia(store, src, [
      { path: path.join(src, 'a.jpg'), content: 'AAA' },
    ]);
    // checksum が呼ばれるたび別値を返す => src と dst が常に不一致。
    let n = 0;
    const fileop = makeFileOp(trash, {
      sameVolume: () => false,
      checksum: async () => `sum-${n++}`,
    });
    const engine = new RestructureEngine(store, fileop);
    const plan = await engine.proposeRestructure(target, DEFAULT_NAMING_RULE);
    const item = store.listRestructureItems(plan.id)[0];

    await engine.applyRestructure(plan.id);

    const after = store.listRestructureItems(plan.id)[0];
    expect(after.state).toBe('failed');
    expect(await exists(item.fromPath)).toBe(true); // 原本は消えていない
    expect(trash.count()).toBe(0); // ゴミ箱送りされていない
    expect(await exists(item.toPath)).toBe(false); // 壊れたコピーは破棄
    expect(store.getMedia(media[0].id)!.sourceRef).toBe(item.fromPath); // ref 変わらず
    expect(store.getRestructurePlan(plan.id)!.status).toBe('failed');
  });
});

describe('名前衝突の連番付与 / 空き容量不足で安全に中止', () => {
  it('同一 target になる 2 件へ連番を付ける', async () => {
    const { src, target, trash } = await scratch();
    const store = new InMemoryStore();
    // 同じ日時・拡張子だが元名が同じ -> target 衝突。
    const t = Date.UTC(2024, 7, 15, 9, 30, 12);
    await seedMedia(store, src, [
      { path: path.join(src, 'dup', 'IMG.jpg'), content: '1', createdAt: t },
      { path: path.join(src, 'dup2', 'IMG.jpg'), content: '2', createdAt: t },
    ]);
    // 元名を捨てて日時のみにすると確実に衝突する命名規則。
    const fileop = makeFileOp(trash);
    const engine = new RestructureEngine(store, fileop);
    const plan = await engine.proposeRestructure(target, {
      yearFolder: true,
      dateEventFolder: true,
      dateTimePrefix: true,
      keepOriginalName: false,
    });
    const toPaths = plan.items.map((i) => i.toPath);
    expect(new Set(toPaths).size).toBe(2); // 重複しない
    expect(plan.conflicts.length).toBe(1); // 1 件が連番で回避された
  });

  it('空き容量不足なら着手前に中止し、原本を一切動かさない', async () => {
    const { src, target, trash } = await scratch();
    const store = new InMemoryStore();
    const { media } = await seedMedia(store, src, [
      { path: path.join(src, 'big.jpg'), content: 'X'.repeat(1000) },
    ]);
    const fileop = makeFileOp(trash, { sameVolume: () => false, freeSpace: 10 });
    const engine = new RestructureEngine(store, fileop);
    const plan = await engine.proposeRestructure(target, DEFAULT_NAMING_RULE);
    expect(plan.spaceRequired).toBe(1000);

    await expect(engine.applyRestructure(plan.id)).rejects.toThrow(/空き容量不足/);

    const item = store.listRestructureItems(plan.id)[0];
    expect(item.state).toBe('pending'); // 一切進んでいない
    expect(await exists(media[0].sourceRef)).toBe(true);
    expect(trash.count()).toBe(0);
    expect(store.getRestructurePlan(plan.id)!.status).toBe('failed');
  });
});

describe('Undo で全ファイルが元パスへ戻る', () => {
  it('同一ドライブ move の Undo', async () => {
    const { src, target, trash } = await scratch();
    const store = new InMemoryStore();
    const { media } = await seedMedia(store, src, [
      { path: path.join(src, 'a.jpg'), content: 'AAA' },
      { path: path.join(src, 'b.jpg'), content: 'BBB' },
    ]);
    const fileop = makeFileOp(trash);
    const engine = new RestructureEngine(store, fileop);
    const plan = await engine.proposeRestructure(target, DEFAULT_NAMING_RULE);
    await engine.applyRestructure(plan.id);

    await engine.undo(plan.id);

    for (const m0 of media) {
      expect(await exists(m0.sourceRef)).toBe(true); // 元パスに復帰
      expect(store.getMedia(m0.id)!.sourceRef).toBe(m0.sourceRef);
    }
    expect(store.getRestructurePlan(plan.id)!.status).toBe('reverted');
  });

  it('ドライブ跨ぎの Undo（ゴミ箱から復元 + コピー破棄）', async () => {
    const { src, target, trash } = await scratch();
    const store = new InMemoryStore();
    const { media } = await seedMedia(store, src, [
      { path: path.join(src, 'a.jpg'), content: 'AAA' },
    ]);
    const fileop = makeFileOp(trash, { sameVolume: () => false });
    const engine = new RestructureEngine(store, fileop);
    const plan = await engine.proposeRestructure(target, DEFAULT_NAMING_RULE);
    const item = store.listRestructureItems(plan.id)[0];
    await engine.applyRestructure(plan.id);
    expect(await exists(item.toPath)).toBe(true);

    await engine.undo(plan.id);

    expect(await exists(media[0].sourceRef)).toBe(true); // 元パスに復元
    expect(await read(media[0].sourceRef)).toBe('AAA');
    expect(await exists(item.toPath)).toBe(false); // コピーは破棄
    expect(store.getMedia(media[0].id)!.sourceRef).toBe(media[0].sourceRef);
  });
});

describe('他アプリ管理下フォルダは再配置対象外', () => {
  it('managedByOtherApp の root の media は plan に含まれない', async () => {
    const { src, target, trash } = await scratch();
    const store = new InMemoryStore();
    await seedMedia(
      store,
      src,
      [{ path: path.join(src, 'photo.jpg'), content: 'P' }],
      { managedByOtherApp: true },
    );
    const engine = new RestructureEngine(store, makeFileOp(trash));
    const plan = await engine.proposeRestructure(target, DEFAULT_NAMING_RULE);
    expect(plan.items.length).toBe(0);
  });
});
