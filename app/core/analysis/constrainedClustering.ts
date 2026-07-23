// ============================================================================
// 制約付き（増分）クラスタリング (P2 §B-3 / M10)。
// ユーザーの訂正を制約として尊重する:
//   confirm = must-link（この顔はこの人物）→ 必ずその人物クラスタへ
//   reject  = cannot-link（この人物ではない）→ 絶対にその人物クラスタへ入れない
// 新規の顔は人物アンカー（確定顔の重心）にANN的に最も近ければ割り当て、外れれば新規。
// 「訂正が再クラスタで巻き戻らない」ことを保証する。
// ============================================================================

import type { FaceFeedback } from '../../shared/types.js';
import { newId } from '../../shared/util.js';
import { cosineDistance } from '../ann/vectorIndex.js';

export interface ConstraintFace {
  faceId: string;
  embedding: Float32Array;
  /** 現在のクラスタ（初回は P1 のクラスタ）。 */
  clusterId?: string;
}

export interface PersonAnchor {
  personId: string;
  clusterId: string;
}

export interface ReclusterResult {
  /** faceId -> clusterId */
  assignments: Map<string, string>;
}

export interface ReclusterOptions {
  /** 人物アンカーに割り当てる最大コサイン距離。 */
  threshold?: number;
}

function meanNormalized(vectors: Float32Array[]): Float32Array | null {
  if (vectors.length === 0) return null;
  const dim = vectors[0].length;
  const acc = new Float32Array(dim);
  for (const v of vectors) for (let i = 0; i < dim; i++) acc[i] += v[i];
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    acc[i] /= vectors.length;
    norm += acc[i] * acc[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) acc[i] /= norm;
  return acc;
}

export function reclusterWithConstraints(
  faces: ConstraintFace[],
  persons: PersonAnchor[],
  feedback: FaceFeedback[],
  opts: ReclusterOptions = {},
): ReclusterResult {
  const threshold = opts.threshold ?? 0.35;

  const personCluster = new Map<string, string>();
  const clusterToPerson = new Map<string, string>();
  for (const p of persons) {
    personCluster.set(p.personId, p.clusterId);
    clusterToPerson.set(p.clusterId, p.personId);
  }

  // 制約を整理（同一 face×person は最新の verdict を採用）。
  const confirmByFace = new Map<string, string>(); // faceId -> personId
  const rejectByFace = new Map<string, Set<string>>(); // faceId -> {personId}
  const sorted = [...feedback].sort((a, b) => a.createdAt - b.createdAt);
  for (const f of sorted) {
    if (f.verdict === 'confirm') {
      confirmByFace.set(f.faceId, f.personId);
      // confirm は同一 person の reject を打ち消す
      rejectByFace.get(f.faceId)?.delete(f.personId);
    } else {
      let set = rejectByFace.get(f.faceId);
      if (!set) {
        set = new Set();
        rejectByFace.set(f.faceId, set);
      }
      set.add(f.personId);
      if (confirmByFace.get(f.faceId) === f.personId) confirmByFace.delete(f.faceId);
    }
  }

  const byFaceId = new Map(faces.map((f) => [f.faceId, f]));

  // 人物アンカー（重心）を作る。確定顔があればそれ、無ければ現クラスタの顔から。
  const anchors = new Map<string, Float32Array>();
  for (const p of persons) {
    const confirmed: Float32Array[] = [];
    for (const [faceId, pid] of confirmByFace) {
      if (pid === p.personId) {
        const f = byFaceId.get(faceId);
        if (f) confirmed.push(f.embedding);
      }
    }
    let centroid = meanNormalized(confirmed);
    if (!centroid) {
      const members = faces
        .filter((f) => f.clusterId === p.clusterId && !rejectByFace.get(f.faceId)?.has(p.personId))
        .map((f) => f.embedding);
      centroid = meanNormalized(members);
    }
    if (centroid) anchors.set(p.personId, centroid);
  }

  const assignments = new Map<string, string>();
  for (const f of faces) {
    // 1) confirm は最優先（must-link）。
    const confirmedPid = confirmByFace.get(f.faceId);
    if (confirmedPid && personCluster.has(confirmedPid)) {
      assignments.set(f.faceId, personCluster.get(confirmedPid)!);
      continue;
    }
    const rejected = rejectByFace.get(f.faceId) ?? new Set<string>();

    // 2) 人物アンカーへの最近傍（reject された人物は除外）。
    let best: { personId: string; dist: number } | null = null;
    for (const [pid, centroid] of anchors) {
      if (rejected.has(pid)) continue;
      const dist = cosineDistance(f.embedding, centroid);
      if (!best || dist < best.dist) best = { personId: pid, dist };
    }
    if (best && best.dist <= threshold) {
      assignments.set(f.faceId, personCluster.get(best.personId)!);
      continue;
    }

    // 3) 既存クラスタを維持（ただし reject された人物のクラスタは避ける）。
    if (f.clusterId) {
      const owner = clusterToPerson.get(f.clusterId);
      if (!owner || !rejected.has(owner)) {
        assignments.set(f.faceId, f.clusterId);
        continue;
      }
    }

    // 4) それ以外は新規クラスタ。
    assignments.set(f.faceId, newId('cluster'));
  }

  return { assignments };
}
