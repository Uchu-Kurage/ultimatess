// ============================================================================
// MLAdapter (設計書 v3 §5.3 / P1 §6 / §8)。オンデバイス ML の抽象化。
// 既定は ONNX バンドル想定だが、実モデル確定前は MockMLAdapter で先行する（§11）。
// モデルは /models に差し替え可能な形で置き、この Adapter 越しにのみ参照する。
// ============================================================================

import type { FaceDetection, QualityScore } from '../../shared/types.js';

export interface MLAdapter {
  detectFaces(img: Buffer): Promise<FaceDetection[]>;
  embedFace(img: Buffer, face: FaceDetection): Promise<Float32Array>; // 512d
  scoreQuality(img: Buffer): Promise<QualityScore>;
  classifyScene?(img: Buffer): Promise<{ label: string; confidence: number }[]>;
}

/** 決定論的な擬似乱数（画像内容から安定した特徴量を作るため）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromBuffer(buf: Buffer): number {
  let h = 2166136261;
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i];
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 実モデルが無い環境向けの決定論的モック。
 * 同一バイト列からは常に同一の顔数・埋め込み・品質を返すので、
 * クラスタリング/重複/選抜のロジックをテストできる。
 */
export class MockMLAdapter implements MLAdapter {
  async detectFaces(img: Buffer): Promise<FaceDetection[]> {
    const rnd = mulberry32(seedFromBuffer(img));
    const count = Math.floor(rnd() * 3); // 0..2 人
    const faces: FaceDetection[] = [];
    for (let i = 0; i < count; i++) {
      faces.push({
        bbox: [rnd(), rnd(), 0.2 + rnd() * 0.2, 0.2 + rnd() * 0.2],
        quality: 0.5 + rnd() * 0.5,
        eyesOpen: rnd() > 0.2,
      });
    }
    return faces;
  }

  async embedFace(img: Buffer, face: FaceDetection): Promise<Float32Array> {
    // 画像内容 + bbox から 512d を生成し L2 正規化。
    const seed = seedFromBuffer(img) ^ Math.floor(face.bbox[0] * 1e6);
    const rnd = mulberry32(seed);
    const v = new Float32Array(512);
    let norm = 0;
    for (let i = 0; i < 512; i++) {
      v[i] = rnd() * 2 - 1;
      norm += v[i] * v[i];
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < 512; i++) v[i] /= norm;
    return v;
  }

  async scoreQuality(img: Buffer): Promise<QualityScore> {
    const rnd = mulberry32(seedFromBuffer(img) ^ 0x9e3779b9);
    const sharpness = rnd();
    const exposure = rnd();
    const composition = rnd();
    const eyesOpen = rnd();
    const composite = sharpness * 0.4 + exposure * 0.2 + composition * 0.2 + eyesOpen * 0.2;
    return { sharpness, exposure, composition, eyesOpen, composite };
  }
}
