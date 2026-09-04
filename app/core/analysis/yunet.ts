// ============================================================================
// YuNet (OpenCV Zoo / libfacedetection) の出力デコード。純関数=テスト可能。
//
// YuNet の生 ONNX 出力はストライド {8,16,32} ごとの 4 系統:
//   cls_{s}  : [N,1] 分類スコア
//   obj_{s}  : [N,1] オブジェクトスコア
//   bbox_{s} : [N,4] (dx,dy,dw,dh) アンカー相対
//   kps_{s}  : [N,10] 5 点ランドマーク（アンカー相対）
// ここで N = (inputH/s)*(inputW/s)。OpenCV FaceDetectorYN と同じ後処理を再現する:
//   score = sqrt(cls*obj)
//   cx=(c+dx)*s, cy=(r+dy)*s, w=exp(dw)*s, h=exp(dh)*s  （入力座標）
// 最後に入力→元画像の非等方スケール(origW/inputW, origH/inputH)で戻す
// （YuNet は letterbox せず stretch リサイズするため軸ごとに別スケール）。
// ============================================================================

import type { ScoredBox } from './detectUtils.js';

export interface RawOutput {
  data: Float32Array;
  dims: number[];
}

export interface YuNetDecodeOptions {
  inputW: number;
  inputH: number;
  strides: number[];
  scoreThreshold: number;
}

/** name→出力のマップから、種類(kind)とストライド(s)に対応する出力を探す。 */
function pick(
  outputs: Record<string, RawOutput>,
  kind: 'cls' | 'obj' | 'bbox' | 'kps',
  s: number,
): RawOutput | null {
  const exact = outputs[`${kind}_${s}`];
  if (exact) return exact;
  // 名前が微妙に違うモデル向けのフォールバック（kind を含み末尾が stride）。
  for (const [name, out] of Object.entries(outputs)) {
    const n = name.toLowerCase();
    if (n.includes(kind) && (n.endsWith(String(s)) || n.includes(`_${s}`) || n.includes(`${s}_`)))
      return out;
  }
  return null;
}

export function decodeYuNet(
  outputs: Record<string, RawOutput>,
  opts: YuNetDecodeOptions,
  origW: number,
  origH: number,
): ScoredBox[] {
  const boxes: ScoredBox[] = [];
  const sx = origW / opts.inputW;
  const sy = origH / opts.inputH;

  for (const s of opts.strides) {
    const cls = pick(outputs, 'cls', s);
    const obj = pick(outputs, 'obj', s);
    const bbox = pick(outputs, 'bbox', s);
    const kps = pick(outputs, 'kps', s);
    if (!cls || !obj || !bbox) continue;

    const cols = Math.round(opts.inputW / s);
    const n = cls.data.length; // = rows*cols
    for (let idx = 0; idx < n; idx++) {
      const clsV = clamp01(cls.data[idx]);
      const objV = clamp01(obj.data[idx]);
      const score = Math.sqrt(clsV * objV);
      if (score < opts.scoreThreshold) continue;

      const r = Math.floor(idx / cols);
      const c = idx % cols;
      const b = idx * 4;
      const cx = (c + bbox.data[b]) * s;
      const cy = (r + bbox.data[b + 1]) * s;
      const w = Math.exp(bbox.data[b + 2]) * s;
      const h = Math.exp(bbox.data[b + 3]) * s;
      const x = cx - w / 2;
      const y = cy - h / 2;

      const box: ScoredBox = {
        bbox: [x * sx, y * sy, w * sx, h * sy],
        score,
      };
      if (kps) {
        const k = idx * 10;
        const lm: number[] = [];
        for (let p = 0; p < 5; p++) {
          lm.push((c + kps.data[k + 2 * p]) * s * sx);
          lm.push((r + kps.data[k + 2 * p + 1]) * s * sy);
        }
        box.landmarks = lm;
      }
      boxes.push(box);
    }
  }
  return boxes;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
