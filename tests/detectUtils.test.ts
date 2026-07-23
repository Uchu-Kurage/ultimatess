// ============================================================================
// 顔検出の前処理・後処理（モデル非依存の純ロジック）のテスト。
// NodeMLAdapter 本体はネイティブ(onnxruntime/sharp)依存のためこの環境では未実行だが、
// レターボックス座標変換・IoU・NMS・L2 正規化はここで担保する。
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  iou,
  l2normalize,
  letterbox,
  nms,
  unletterboxBBox,
  type ScoredBox,
} from '../app/core/analysis/detectUtils.js';

describe('letterbox / unletterbox', () => {
  it('アスペクト比を保ってパディング量を計算する', () => {
    // 200x100 を 100x100 に収める → scale 0.5, newH 50, padY 25
    const lb = letterbox(200, 100, 100, 100);
    expect(lb.scale).toBe(0.5);
    expect(lb.newW).toBe(100);
    expect(lb.newH).toBe(50);
    expect(lb.padY).toBe(25);
    expect(lb.padX).toBe(0);
  });

  it('入力座標の bbox を元画像座標へ正しく戻す', () => {
    const lb = letterbox(200, 100, 100, 100); // scale .5, padY 25
    // 入力上の [10, 35, 20, 10] → 元では [(10)/.5, (35-25)/.5, 40, 20] = [20,20,40,20]
    const back = unletterboxBBox([10, 35, 20, 10], lb, 200, 100);
    expect(back[0]).toBeCloseTo(20);
    expect(back[1]).toBeCloseTo(20);
    expect(back[2]).toBeCloseTo(40);
    expect(back[3]).toBeCloseTo(20);
  });
});

describe('IoU / NMS', () => {
  it('IoU: 完全一致は1、非重複は0', () => {
    expect(iou([0, 0, 10, 10], [0, 0, 10, 10])).toBeCloseTo(1);
    expect(iou([0, 0, 10, 10], [20, 20, 10, 10])).toBe(0);
    expect(iou([0, 0, 10, 10], [5, 0, 10, 10])).toBeCloseTo(50 / 150, 5);
  });

  it('NMS: 高スコアを残し、重複を抑制する', () => {
    const boxes: ScoredBox[] = [
      { bbox: [0, 0, 10, 10], score: 0.9 },
      { bbox: [1, 1, 10, 10], score: 0.8 }, // ほぼ重複 → 抑制
      { bbox: [50, 50, 10, 10], score: 0.7 }, // 別位置 → 残る
    ];
    const kept = nms(boxes, 0.4);
    expect(kept).toHaveLength(2);
    expect(kept[0].score).toBe(0.9);
    expect(kept[1].bbox[0]).toBe(50);
  });
});

describe('l2normalize', () => {
  it('ノルム1に正規化する', () => {
    const v = l2normalize(Float32Array.from([3, 4]));
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(1, 6);
    expect(v[0]).toBeCloseTo(0.6, 6);
  });
});
