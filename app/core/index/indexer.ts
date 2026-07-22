// ============================================================================
// Indexer (設計書 v3 §5.2 / P1 M1)。
// 差分検出 → メタ/サムネ抽出 → media_item 投入 → 解析ジョブ対象化。
// 10万規模前提: インクリメンタル＋再開可能（再実行で既存分をスキップ）。
// ============================================================================

import type { MediaItem } from '../../shared/types.js';
import { newId } from '../../shared/util.js';
import type { JobContext } from '../jobs/jobOrchestrator.js';
import type { SourceProvider } from '../source/sourceProvider.js';
import { looksManagedByOtherApp } from '../source/sourceProvider.js';
import type { Store } from '../store/store.js';
import type { MediaProbe } from './mediaProbe.js';

export interface IndexResult {
  added: number;
  updated: number;
  skipped: number;
}

export type IndexUpdatedListener = (rootId: string, added: number, updated: number) => void;

export class Indexer {
  constructor(
    private readonly store: Store,
    private readonly provider: SourceProvider,
    private readonly probe: MediaProbe,
    private readonly onUpdated?: IndexUpdatedListener,
  ) {}

  /**
   * ルートを索引する。ctx があればジョブとして進捗報告・pause/cancel に対応。
   * 既に索引済み（source_ref 一致）のファイルはスキップするので、再実行で重複なく再開できる。
   */
  async indexRoot(rootId: string, ctx?: JobContext): Promise<IndexResult> {
    const root = this.store.getRoot(rootId);
    if (!root) throw new Error(`root not found: ${rootId}`);

    const online = await this.provider.isOnline(root);
    this.store.setRootOnline(rootId, online);
    if (!online) throw new Error(`root offline: ${root.path}`);

    // 先に走査してファイル一覧を確定（total を得る）。
    const files: { path: string; mtime: number; size: number }[] = [];
    for await (const f of this.provider.scan(root)) files.push(f);

    const result: IndexResult = { added: 0, updated: 0, skipped: 0 };
    const total = files.length;
    ctx?.setProgress(0, total);

    for (let i = 0; i < files.length; i++) {
      if (ctx) await ctx.checkpoint();
      const f = files[i];
      const existing = this.store.getMediaBySourceRef(f.path);
      if (existing) {
        result.skipped += 1;
      } else if (looksManagedByOtherApp(f.path)) {
        // 念のため二重チェック。
        result.skipped += 1;
      } else {
        const probed = await this.probe.probe(f);
        const item: MediaItem = {
          id: newId('m'),
          rootId,
          sourceRef: f.path,
          mediaType: probed.mediaType,
          createdAt: probed.createdAt,
          dateUncertain: probed.dateUncertain,
          ...(probed.gps ? { gps: probed.gps } : {}),
          width: probed.width,
          height: probed.height,
          ...(probed.durationMs != null ? { durationMs: probed.durationMs } : {}),
          orientation: probed.orientation,
          contentHash: probed.contentHash,
          perceptualHash: probed.perceptualHash,
          thumbPath: probed.thumbPath,
          previewPath: probed.previewPath,
          analysisStatus: 'pending',
        };
        this.store.upsertMedia(item);
        result.added += 1;
      }
      ctx?.setProgress(i + 1, total);
    }

    this.onUpdated?.(rootId, result.added, result.updated);
    return result;
  }
}
