// ============================================================================
// 解析パイプライン (設計書 v3 §5.3 / P1 M2)。
// pending メディアを ML にかけ、顔・品質を保存 → ANN 構築 → クラスタリング/重複。
// メディア単位で analysis_status を更新するので、再実行で途中から再開できる。
// ============================================================================

import type { Face } from '../../shared/types.js';
import { newId } from '../../shared/util.js';
import { BruteForceVectorIndex, type VectorIndex } from '../ann/vectorIndex.js';
import type { JobContext } from '../jobs/jobOrchestrator.js';
import { buildDuplicateGroups } from '../organize/dedup.js';
import type { SourceProvider } from '../source/sourceProvider.js';
import type { Store } from '../store/store.js';
import { clusterFaces, type FaceVec } from './clustering.js';
import type { MLAdapter } from './mlAdapter.js';

export interface AnalyzerOptions {
  /** クラスタリング用 VectorIndex を作る（既定はブルートフォース／本番は HNSW）。 */
  vectorIndexFactory?: () => VectorIndex;
  clusterThreshold?: number;
}

export class Analyzer {
  constructor(
    private readonly store: Store,
    private readonly provider: SourceProvider,
    private readonly ml: MLAdapter,
    private readonly opts: AnalyzerOptions = {},
  ) {}

  async analyzeAll(ctx?: JobContext): Promise<void> {
    const pending = this.store.listMediaByStatus('pending');
    const total = pending.length;
    ctx?.setProgress(0, total);

    for (let i = 0; i < pending.length; i++) {
      if (ctx) await ctx.checkpoint();
      const m = pending[i];
      try {
        // 派生プレビューがあればそれを、無ければ原本を読む（原本は読み取り専用）。
        const buf = await this.readImage(m.previewPath || m.sourceRef);
        const faces = await this.ml.detectFaces(buf);
        for (const fd of faces) {
          const embedding = await this.ml.embedFace(buf, fd);
          const face: Face = {
            id: newId('face'),
            mediaId: m.id,
            bbox: fd.bbox,
            ...(fd.landmarks ? { landmarks: fd.landmarks } : {}),
            quality: fd.quality,
            eyesOpen: fd.eyesOpen,
            embedding,
          };
          this.store.insertFace(face);
        }
        const q = await this.ml.scoreQuality(buf);
        this.store.upsertQuality(m.id, q);
        this.store.setAnalysisStatus(m.id, 'done');
      } catch (err) {
        this.store.setAnalysisStatus(m.id, 'failed');
        void err;
      }
      ctx?.setProgress(i + 1, total);
    }

    await this.rebuildClusters();
    this.rebuildDuplicates();
  }

  /** 全顔から ANN を構築し直しクラスタリング。 */
  async rebuildClusters(): Promise<void> {
    const faces = this.store.listAllFaces();
    const vecs: FaceVec[] = faces.map((f) => ({ faceId: f.id, embedding: f.embedding }));
    if (vecs.length === 0) return;
    const index = this.opts.vectorIndexFactory?.() ?? new BruteForceVectorIndex();
    const { assignments } = clusterFaces(vecs, index, this.opts.clusterThreshold ?? 0.35);
    for (const [faceId, clusterId] of assignments) this.store.setFaceCluster(faceId, clusterId);
  }

  /** 品質を加味して重複グループを再構築。 */
  rebuildDuplicates(): void {
    const media = this.store.allMedia();
    const groups = buildDuplicateGroups({
      media,
      qualityOf: (id) => this.store.getQuality(id)?.composite ?? 0,
    });
    this.store.replaceDuplicateGroups(groups);
  }

  private async readImage(p: string): Promise<Buffer> {
    return this.provider.read(p);
  }
}
