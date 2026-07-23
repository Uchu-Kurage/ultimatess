// ============================================================================
// 空き容量最適化レポート (P2 §C-3 / M12)。
// 回収可能容量（重複・不要・動画プロキシ）／年別使用量／大きいファイルを集計する。
// ファイルサイズは原本を stat して求める（レポートは背景処理・頻度低）。
// ============================================================================

import * as fs from 'node:fs/promises';
import type { MediaItem, SpaceReport } from '../../shared/types.js';
import type { Store } from '../store/store.js';
import { detectJunk } from './junk.js';

async function sizeOf(p: string): Promise<number> {
  try {
    return (await fs.stat(p)).size;
  } catch {
    return 0;
  }
}

export interface SpaceReportOptions {
  /** 大きいファイル一覧の件数。 */
  largestCount?: number;
}

export async function buildSpaceReport(
  store: Store,
  opts: SpaceReportOptions = {},
): Promise<SpaceReport> {
  const largestCount = opts.largestCount ?? 20;
  const media = store.allMedia();

  // 原本サイズをまとめて取得。
  const sizes = new Map<string, number>();
  for (const m of media) sizes.set(m.id, await sizeOf(m.sourceRef));

  let totalBytes = 0;
  const byYear = new Map<string, { bytes: number; count: number }>();
  for (const m of media) {
    const s = sizes.get(m.id) ?? 0;
    totalBytes += s;
    const year = m.createdAt != null ? String(new Date(m.createdAt).getUTCFullYear()) : 'unknown';
    const y = byYear.get(year) ?? { bytes: 0, count: 0 };
    y.bytes += s;
    y.count += 1;
    byYear.set(year, y);
  }

  // 回収可能: 重複（代表以外）。
  let dupReclaim = 0;
  for (const g of store.listDuplicateGroups()) {
    for (const mem of g.members) if (!mem.isRepresentative) dupReclaim += sizes.get(mem.mediaId) ?? 0;
  }

  // 回収可能: 不要写真。
  const junk = detectJunk({ media, qualityOf: (id) => store.getQuality(id) });
  let junkReclaim = 0;
  for (const j of junk) if (j.action === 'trash') junkReclaim += sizes.get(j.mediaId) ?? 0;

  // 回収可能: 動画プロキシ（派生・再生成可能）。
  let proxyReclaim = 0;
  for (const m of media) {
    const proxy = store.getVideoProxyPath(m.id);
    if (proxy) proxyReclaim += await sizeOf(proxy);
  }

  const largest = media
    .map((m: MediaItem) => ({
      mediaId: m.id,
      sourceRef: m.sourceRef,
      bytes: sizes.get(m.id) ?? 0,
      mediaType: m.mediaType,
    }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, largestCount);

  return {
    totalBytes,
    reclaimable: { duplicates: dupReclaim, junk: junkReclaim, videoProxies: proxyReclaim },
    byYear: [...byYear.entries()]
      .map(([year, v]) => ({ year, bytes: v.bytes, count: v.count }))
      .sort((a, b) => b.bytes - a.bytes),
    largest,
  };
}
