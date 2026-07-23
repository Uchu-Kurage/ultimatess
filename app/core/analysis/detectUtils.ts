// ============================================================================
// 顔検出の前処理・後処理ユーティリティ（モデル非依存の純ロジック）。
// レターボックス変換 / IoU / NMS。ここは実データ無しでもユニットテストできる。
// ============================================================================

import type { BBox } from '../../shared/types.js';

export interface LetterboxParams {
  /** リサイズ後の実描画幅・高さ（パディング前）。 */
  newW: number;
  newH: number;
  /** 左・上パディング量（ピクセル）。 */
  padX: number;
  padY: number;
  /** 元画像→入力画像のスケール（等方）。 */
  scale: number;
}

/**
 * アスペクト比を保って (targetW,targetH) に収めるレターボックスのパラメータを計算。
 * 検出結果を元画像座標へ戻すのに使う。
 */
export function letterbox(
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number,
): LetterboxParams {
  const scale = Math.min(targetW / srcW, targetH / srcH);
  const newW = Math.round(srcW * scale);
  const newH = Math.round(srcH * scale);
  const padX = Math.floor((targetW - newW) / 2);
  const padY = Math.floor((targetH - newH) / 2);
  return { newW, newH, padX, padY, scale };
}

/** 入力画像座標(パディング込み)の bbox を元画像座標へ戻す。 */
export function unletterboxBBox(
  bbox: BBox,
  lb: LetterboxParams,
  srcW: number,
  srcH: number,
): BBox {
  const [x, y, w, h] = bbox;
  const rx = (x - lb.padX) / lb.scale;
  const ry = (y - lb.padY) / lb.scale;
  const rw = w / lb.scale;
  const rh = h / lb.scale;
  return [
    Math.max(0, Math.min(srcW, rx)),
    Math.max(0, Math.min(srcH, ry)),
    Math.max(0, Math.min(srcW, rw)),
    Math.max(0, Math.min(srcH, rh)),
  ];
}

/** 2 つの bbox([x,y,w,h]) の IoU。 */
export function iou(a: BBox, b: BBox): number {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);
  const iw = Math.max(0, x2 - x1);
  const ih = Math.max(0, y2 - y1);
  const inter = iw * ih;
  const union = aw * ah + bw * bh - inter;
  return union <= 0 ? 0 : inter / union;
}

export interface ScoredBox {
  bbox: BBox;
  score: number;
  landmarks?: number[];
}

/**
 * Non-Maximum Suppression。スコア降順に貪欲に採用し、IoU が閾値超の重複を除去。
 */
export function nms(boxes: ScoredBox[], iouThreshold = 0.4, maxOut = 100): ScoredBox[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const keep: ScoredBox[] = [];
  for (const cand of sorted) {
    if (keep.length >= maxOut) break;
    let overlap = false;
    for (const k of keep) {
      if (iou(cand.bbox, k.bbox) > iouThreshold) {
        overlap = true;
        break;
      }
    }
    if (!overlap) keep.push(cand);
  }
  return keep;
}

/** ベクトルを L2 正規化（ArcFace 埋め込みの後処理）。 */
export function l2normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}
