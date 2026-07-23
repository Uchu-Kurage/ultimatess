// ============================================================================
// 数百件規模の Undo を実ファイルで検証する。
// 同一ドライブ(rename)・ドライブ跨ぎ(copy→verify→trash) の両経路で、
// 全ファイルが元パスへ完全復帰し、内容・source_ref も一致することを確かめる。
// ============================================================================

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { InMemoryStore } from '../app/core/store/inMemoryStore.js';
import { RestructureEngine } from '../app/core/organize/restructure.js';
import { DEFAULT_NAMING_RULE } from '../app/shared/types.js';
import { exists, makeFileOp, read, seedMedia, TestTrash, tmpDir } from './helpers.js';

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true }).catch(() => {});
});

async function scratch() {
  const base = await tmpDir();
  cleanups.push(base);
  const src = path.join(base, 'source');
  const target = path.join(base, 'library');
  const trash = new TestTrash(path.join(base, 'trash'));
  await fs.mkdir(src, { recursive: true });
  await fs.mkdir(target, { recursive: true });
  return { src, target, trash };
}

// 日時をばらけさせ、年/日付フォルダも複数生成させる。
function makeFiles(src: string, n: number) {
  return Array.from({ length: n }, (_, i) => {
    const day = (i % 27) + 1;
    const month = (i % 12) + 1;
    return {
      path: path.join(src, `sub${i % 7}`, `IMG_${String(i).padStart(4, '0')}.jpg`),
      content: `content-of-${i}-${'x'.repeat(i % 13)}`,
      createdAt: Date.UTC(2022 + (i % 3), month - 1, day, i % 24, i % 60, i % 60),
    };
  });
}

describe('数百件規模の Undo（同一ドライブ）', () => {
  it('300 件を再配置後、Undo で全件が元パスへ完全復帰する', async () => {
    const { src, target, trash } = await scratch();
    const store = new InMemoryStore();
    const N = 300;
    const files = makeFiles(src, N);
    const { media } = await seedMedia(store, src, files);
    const originals = media.map((m) => ({ id: m.id, path: m.sourceRef, content: files.find((f) => f.path === m.sourceRef)!.content }));

    const engine = new RestructureEngine(store, makeFileOp(trash));
    const plan = await engine.proposeRestructure(target, DEFAULT_NAMING_RULE);
    expect(plan.items.length).toBe(N);
    await engine.applyRestructure(plan.id);

    // 再配置後: 元パスは空、target に存在。
    for (const o of originals) expect(await exists(o.path)).toBe(false);

    // --- Undo ---
    await engine.undo(plan.id);

    // 全件が元パスへ完全復帰し、内容と source_ref が一致。
    for (const o of originals) {
      expect(await exists(o.path), o.path).toBe(true);
      expect(await read(o.path)).toBe(o.content);
      expect(store.getMedia(o.id)!.sourceRef).toBe(o.path);
    }
    // target 側にファイルが残っていない（移動済みなので）。
    const leftover = await countFiles(target);
    expect(leftover).toBe(0);
    expect(store.getRestructurePlan(plan.id)!.status).toBe('reverted');
  });
});

describe('数百件規模の Undo（ドライブ跨ぎ）', () => {
  it('200 件を copy→verify→trash 後、Undo でゴミ箱から全件復元しコピーを破棄する', async () => {
    const { src, target, trash } = await scratch();
    const store = new InMemoryStore();
    const N = 200;
    const files = makeFiles(src, N);
    const { media } = await seedMedia(store, src, files);
    const originals = media.map((m) => ({ id: m.id, path: m.sourceRef, content: files.find((f) => f.path === m.sourceRef)!.content }));

    // sameVolume を false 固定してドライブ跨ぎ経路を通す。
    const engine = new RestructureEngine(store, makeFileOp(trash, { sameVolume: () => false }));
    const plan = await engine.proposeRestructure(target, DEFAULT_NAMING_RULE);
    expect(plan.items.every((i) => !i.sameDrive)).toBe(true);
    await engine.applyRestructure(plan.id);

    expect(trash.count()).toBe(N); // 原本は全てゴミ箱へ
    for (const o of originals) expect(await exists(o.path)).toBe(false);

    // --- Undo ---
    await engine.undo(plan.id);

    for (const o of originals) {
      expect(await exists(o.path), o.path).toBe(true);
      expect(await read(o.path)).toBe(o.content);
      expect(store.getMedia(o.id)!.sourceRef).toBe(o.path);
    }
    // 原本はゴミ箱から取り出され、代わりにコピーがゴミ箱へ退避される
    // （ハード削除しない = さらに復元可能）。target 側は空になる。
    expect(trash.count()).toBe(N);
    expect(await countFiles(target)).toBe(0); // コピーは target から除去
  });
});

async function countFiles(dir: string): Promise<number> {
  let n = 0;
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const full = path.join(dir, name);
    const st = await fs.stat(full);
    if (st.isDirectory()) n += await countFiles(full);
    else if (st.isFile() && !name.endsWith('.part')) n += 1;
  }
  return n;
}
