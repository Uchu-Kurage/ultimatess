// ============================================================================
// YuNet デコードの検証（合成テンソルで OpenCV 相当の後処理を確認）。
// 実モデル・onnxruntime 無しで、最も間違えやすいデコード算術を担保する。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { decodeYuNet, type RawOutput } from '../app/core/analysis/yunet.js';

function zeros(n: number): Float32Array {
  return new Float32Array(n);
}

describe('decodeYuNet', () => {
  // 入力 32x32、ストライド 8 のみ → 特徴マップ 4x4 = 16 アンカー。
  const inputW = 32;
  const inputH = 32;
  const stride = 8;
  const N = (inputW / stride) * (inputH / stride); // 16

  function build(anchorIdx: number, cls: number, obj: number, dbox: number[]): Record<string, RawOutput> {
    const clsD = zeros(N);
    const objD = zeros(N);
    const bboxD = zeros(N * 4);
    clsD[anchorIdx] = cls;
    objD[anchorIdx] = obj;
    bboxD[anchorIdx * 4 + 0] = dbox[0];
    bboxD[anchorIdx * 4 + 1] = dbox[1];
    bboxD[anchorIdx * 4 + 2] = dbox[2];
    bboxD[anchorIdx * 4 + 3] = dbox[3];
    return {
      cls_8: { data: clsD, dims: [1, N, 1] },
      obj_8: { data: objD, dims: [1, N, 1] },
      bbox_8: { data: bboxD, dims: [1, N, 4] },
    };
  }

  it('score=sqrt(cls*obj) と閾値を正しく扱う', () => {
    const outputs = build(0, 0.81, 1.0, [0, 0, 0, 0]);
    const boxes = decodeYuNet(outputs, { inputW, inputH, strides: [stride], scoreThreshold: 0.5 }, 32, 32);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].score).toBeCloseTo(0.9, 5); // sqrt(0.81)

    // 閾値超で除外
    const none = decodeYuNet(build(0, 0.04, 1.0, [0, 0, 0, 0]), { inputW, inputH, strides: [stride], scoreThreshold: 0.5 }, 32, 32);
    expect(none).toHaveLength(0);
  });

  it('アンカー位置と (dx,dy,dw,dh) から bbox を復元する', () => {
    // anchor idx=5 → r=1, c=1。dx=dy=0.5（セル中心）、dw=dh=0 → w=h=exp(0)*8=8。
    const idx = 5;
    const outputs = build(idx, 1.0, 1.0, [0.5, 0.5, 0, 0]);
    const boxes = decodeYuNet(outputs, { inputW, inputH, strides: [stride], scoreThreshold: 0.5 }, 32, 32);
    expect(boxes).toHaveLength(1);
    // cx=(1+0.5)*8=12, cy=12, w=8,h=8 → x=8,y=8,w=8,h=8（origW=inputW なのでスケール1）
    const [x, y, w, h] = boxes[0].bbox;
    expect(x).toBeCloseTo(8, 5);
    expect(y).toBeCloseTo(8, 5);
    expect(w).toBeCloseTo(8, 5);
    expect(h).toBeCloseTo(8, 5);
  });

  it('入力→元画像の非等方スケールを軸ごとに適用する', () => {
    const idx = 5;
    const outputs = build(idx, 1.0, 1.0, [0.5, 0.5, 0, 0]);
    // 元画像 64x96 → sx=2, sy=3
    const boxes = decodeYuNet(outputs, { inputW, inputH, strides: [stride], scoreThreshold: 0.5 }, 64, 96);
    const [x, y, w, h] = boxes[0].bbox;
    expect(x).toBeCloseTo(16, 5); // 8*2
    expect(y).toBeCloseTo(24, 5); // 8*3
    expect(w).toBeCloseTo(16, 5);
    expect(h).toBeCloseTo(24, 5);
  });

  it('kps があれば 5 点ランドマークを復元する', () => {
    const idx = 0; // r=0,c=0
    const clsD = zeros(N);
    const objD = zeros(N);
    const bboxD = zeros(N * 4);
    const kpsD = zeros(N * 10);
    clsD[idx] = 1;
    objD[idx] = 1;
    kpsD[idx * 10 + 0] = 0.5; // 1点目 x: (0+0.5)*8=4
    kpsD[idx * 10 + 1] = 0.25; // 1点目 y: (0+0.25)*8=2
    const outputs: Record<string, RawOutput> = {
      cls_8: { data: clsD, dims: [N, 1] },
      obj_8: { data: objD, dims: [N, 1] },
      bbox_8: { data: bboxD, dims: [N, 4] },
      kps_8: { data: kpsD, dims: [N, 10] },
    };
    const boxes = decodeYuNet(outputs, { inputW, inputH, strides: [stride], scoreThreshold: 0.5 }, 32, 32);
    expect(boxes[0].landmarks?.slice(0, 2)).toEqual([4, 2]);
  });
});
