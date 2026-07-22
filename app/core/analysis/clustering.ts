// ============================================================================
// 顔クラスタリング (設計書 v3 §5.3 / §9)。
// ANN(VectorIndex) を使う増分クラスタリングで総当たりを避ける。
// アルゴリズム: 各顔を近傍検索し、閾値内の既存クラスタへ single-link で併合。
// ============================================================================

import { newId } from '../../shared/util.js';
import type { VectorIndex } from '../ann/vectorIndex.js';

export interface FaceVec {
  faceId: string;
  embedding: Float32Array;
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let root = this.parent.get(x) ?? x;
    if (!this.parent.has(x)) this.parent.set(x, x);
    while (root !== this.parent.get(root)) {
      const gp = this.parent.get(root)!;
      root = gp;
    }
    // path compression
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export interface ClusterResult {
  /** faceId -> clusterId */
  assignments: Map<string, string>;
  clusterCount: number;
}

/**
 * @param threshold コサイン距離の上限（これ以下を同一人物候補とみなす）。
 * @param k 近傍探索数。
 */
export function clusterFaces(
  faces: FaceVec[],
  index: VectorIndex,
  threshold = 0.35,
  k = 10,
): ClusterResult {
  const uf = new UnionFind();
  for (const f of faces) uf.find(f.faceId); // 各自を初期化

  for (const f of faces) {
    const neighbors = index.search(f.embedding, k);
    for (const n of neighbors) {
      if (n.id === f.faceId) continue;
      if (n.distance <= threshold) uf.union(f.faceId, n.id);
    }
    index.add(f.faceId, f.embedding);
  }

  // 代表 root -> 安定 clusterId へマッピング。
  const rootToCluster = new Map<string, string>();
  const assignments = new Map<string, string>();
  for (const f of faces) {
    const root = uf.find(f.faceId);
    let cid = rootToCluster.get(root);
    if (!cid) {
      cid = newId('cluster');
      rootToCluster.set(root, cid);
    }
    assignments.set(f.faceId, cid);
  }
  return { assignments, clusterCount: rootToCluster.size };
}
