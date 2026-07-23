// ============================================================================
// M12 空き容量最適化: 回収可能容量レポート / 大きいファイル / 外付けアーカイブ。
// 受け入れ(§E): アーカイブ後も派生キャッシュが PC に残り、外付け未接続でも一覧が動く。
// アーカイブは P1 の安全パイプラインを再利用する。
// ============================================================================

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { InMemoryStore } from '../app/core/store/inMemoryStore.js';
import { OrganizeEngine } from '../app/core/organize/organizeEngine.js';
import { buildSpaceReport } from '../app/core/organize/spaceReport.js';
import type { DuplicateGroup } from '../app/shared/types.js';
import { exists, makeFileOp, read, seedMedia, TestTrash, tmpDir } from './helpers.js';

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true }).catch(() => {});
});

describe('空き容量レポート', () => {
  it('重複・年別・大きいファイルを集計する', async () => {
    const base = await tmpDir();
    cleanups.push(base);
    const src = path.join(base, 'src');
    const store = new InMemoryStore();
    const { media } = await seedMedia(store, src, [
      { path: path.join(src, 'a.jpg'), content: 'A'.repeat(100), createdAt: Date.UTC(2024, 0, 1) },
      { path: path.join(src, 'b.jpg'), content: 'B'.repeat(300), createdAt: Date.UTC(2024, 0, 2) },
      { path: path.join(src, 'c.jpg'), content: 'C'.repeat(50), createdAt: Date.UTC(2023, 0, 1) },
    ]);
    // a と b を重複グループ（b が代表）に。
    const group: DuplicateGroup = {
      id: 'g1',
      createdAt: 0,
      members: [
        { groupId: 'g1', mediaId: media[0].id, isRepresentative: false },
        { groupId: 'g1', mediaId: media[1].id, isRepresentative: true },
      ],
    };
    store.replaceDuplicateGroups([group]);

    const report = await buildSpaceReport(store);
    expect(report.totalBytes).toBe(450);
    expect(report.reclaimable.duplicates).toBe(100); // 代表以外(a=100)
    expect(report.largest[0].bytes).toBe(300); // b が最大
    const y2024 = report.byYear.find((y) => y.year === '2024')!;
    expect(y2024.count).toBe(2);
    expect(y2024.bytes).toBe(400);
  });
});

describe('外付けアーカイブ（安全パイプライン再利用・派生は残る）', () => {
  it('指定年の原本だけを移動し、他年とサムネは影響を受けない', async () => {
    const base = await tmpDir();
    cleanups.push(base);
    const src = path.join(base, 'src');
    const ext = path.join(base, 'external');
    await fs.mkdir(ext, { recursive: true });
    const store = new InMemoryStore();
    const { media } = await seedMedia(store, src, [
      { path: path.join(src, 'old.jpg'), content: 'OLD', createdAt: Date.UTC(2019, 5, 1) },
      { path: path.join(src, 'new.jpg'), content: 'NEW', createdAt: Date.UTC(2024, 5, 1) },
    ]);
    // 派生サムネ（PC 側キャッシュ）を付与。
    const thumb = path.join(base, 'cache', 'thumb', 'old.jpg');
    await fs.mkdir(path.dirname(thumb), { recursive: true });
    await fs.writeFile(thumb, 'THUMB');
    const old = media[0];
    store.upsertMedia({ ...store.getMedia(old.id)!, thumbPath: thumb });

    const trash = new TestTrash(path.join(base, 'trash'));
    const org = new OrganizeEngine(store, makeFileOp(trash));

    const plan = await org.proposeArchive('2019', ext);
    expect(plan.items).toHaveLength(1); // 2019 の 1 枚だけ
    expect(plan.items[0].mediaId).toBe(old.id);

    await org.applyRestructure(plan.id);

    // 原本は外付けへ移動、source_ref 更新。
    const movedOld = store.getMedia(old.id)!;
    expect(movedOld.sourceRef.startsWith(ext)).toBe(true);
    expect(await read(movedOld.sourceRef)).toBe('OLD');
    // 2024 の写真は動いていない。
    expect(await exists(media[1].sourceRef)).toBe(true);
    // 派生サムネは PC 側に残る（外付け未接続でも一覧・再生が可能）。
    expect(movedOld.thumbPath).toBe(thumb);
    expect(await exists(thumb)).toBe(true);
  });
});
