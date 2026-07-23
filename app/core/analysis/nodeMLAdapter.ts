// ============================================================================
// NodeMLAdapter — onnxruntime-node による実オンデバイス ML (設計書 §5.3 / §8)。
// - 顔検出(YuNet/SCRFD 想定) → 埋め込み(ArcFace 512d) → 品質ヒューリスティック。
// - GPU 実行プロバイダ(Mac=CoreML / Win=DirectML)を試し、無ければ CPU にフォールバック。
// - モデルは app/models/ に置き、models.json のマニフェストで差し替える。
//
// 重要(正直な注記): 顔検出の出力デコードはモデルのエクスポート形式に依存する。
// ここでは「YuNet を [N,15]=(x,y,w,h, landmarks×10, score) に後処理して出力する」
// 一般的な形式を実装しているが、採用モデルに合わせて decodeDetections を要調整。
// この環境では実モデル・ネイティブ実行ができないため未実行。埋め込みと前処理・NMS の
// 純ロジックは detectUtils のテストで担保している。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { BBox, FaceDetection, QualityScore } from '../../shared/types.js';
import type { MLAdapter } from './mlAdapter.js';
import {
  l2normalize,
  letterbox,
  nms,
  unletterboxBBox,
  type ScoredBox,
} from './detectUtils.js';

export interface DetectorConfig {
  file: string;
  inputSize: [number, number]; // [W,H]
  scoreThreshold: number;
  nmsThreshold: number;
  format: 'yunet15';
}
export interface EmbedderConfig {
  file: string;
  inputSize: [number, number]; // [W,H]
  mean: number;
  std: number;
}
export interface ModelManifest {
  faceDetector?: DetectorConfig;
  faceEmbedder?: EmbedderConfig;
}

function executionProviders(): string[] {
  if (process.platform === 'darwin') return ['coreml', 'cpu'];
  if (process.platform === 'win32') return ['dml', 'cpu'];
  return ['cpu'];
}

export class NodeMLAdapter implements MLAdapter {
  private detector: any = null;
  private embedder: any = null;
  private ort: any = null;

  constructor(
    private readonly modelsDir: string,
    private readonly manifest: ModelManifest,
  ) {}

  private async ortModule(): Promise<any> {
    if (!this.ort) this.ort = await import('onnxruntime-node');
    return this.ort;
  }

  private async session(file: string): Promise<any> {
    const ort = await this.ortModule();
    const full = path.join(this.modelsDir, file);
    const eps = executionProviders();
    // GPU EP → 失敗したら CPU にフォールバック。
    for (const ep of eps) {
      try {
        return await ort.InferenceSession.create(full, { executionProviders: [ep] });
      } catch {
        /* 次の EP へ */
      }
    }
    return ort.InferenceSession.create(full, { executionProviders: ['cpu'] });
  }

  // ---- 前処理: RGB CHW Float32 テンソル（レターボックス） ----
  private async toInputTensor(
    img: Buffer,
    targetW: number,
    targetH: number,
    normalize: (v: number) => number,
  ): Promise<{ tensor: any; srcW: number; srcH: number }> {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(img).metadata();
    const srcW = meta.width ?? targetW;
    const srcH = meta.height ?? targetH;
    // アスペクト比維持で収め、黒でパディング。
    const resized = await sharp(img)
      .resize(targetW, targetH, { fit: 'contain', background: { r: 0, g: 0, b: 0 } })
      .removeAlpha()
      .raw()
      .toBuffer(); // RGBRGB... length = targetW*targetH*3
    const ort = await this.ortModule();
    const chw = new Float32Array(3 * targetW * targetH);
    const plane = targetW * targetH;
    for (let i = 0; i < plane; i++) {
      chw[i] = normalize(resized[i * 3]); // R
      chw[plane + i] = normalize(resized[i * 3 + 1]); // G
      chw[2 * plane + i] = normalize(resized[i * 3 + 2]); // B
    }
    const tensor = new ort.Tensor('float32', chw, [1, 3, targetH, targetW]);
    return { tensor, srcW, srcH };
  }

  async detectFaces(img: Buffer): Promise<FaceDetection[]> {
    const cfg = this.manifest.faceDetector;
    if (!cfg) return [];
    if (!this.detector) this.detector = await this.session(cfg.file);
    const [w, h] = cfg.inputSize;
    const { tensor, srcW, srcH } = await this.toInputTensor(img, w, h, (v) => v); // YuNet は 0..255 生値
    const feeds: Record<string, any> = { [this.detector.inputNames[0]]: tensor };
    const results = await this.detector.run(feeds);
    const out = results[this.detector.outputNames[0]];
    const scored = this.decodeDetections(out, cfg, srcW, srcH);
    const kept = nms(scored, cfg.nmsThreshold);
    return kept.map((s) => ({
      bbox: s.bbox,
      quality: s.score,
      eyesOpen: true, // 目つむり判定は landmark/別モデルが要る。P1 は簡易。
      ...(s.landmarks ? { landmarks: s.landmarks } : {}),
    }));
  }

  /**
   * 検出テンソルを ScoredBox に変換。format='yunet15' は 1 行 15 要素:
   * [x, y, w, h, lm0x, lm0y, ..., lm4x, lm4y, score]（入力画像ピクセル座標）。
   * 採用モデルの形式に合わせて調整すること。
   */
  private decodeDetections(
    out: any,
    cfg: DetectorConfig,
    srcW: number,
    srcH: number,
  ): ScoredBox[] {
    const data = out.data as Float32Array;
    const dims = out.dims as number[];
    const stride = 15;
    const rows = dims[dims.length - 1] === stride ? data.length / stride : dims[0];
    const [inW, inH] = cfg.inputSize;
    const lb = letterbox(srcW, srcH, inW, inH);
    const boxes: ScoredBox[] = [];
    for (let i = 0; i < rows; i++) {
      const o = i * stride;
      const score = data[o + 14];
      if (score < cfg.scoreThreshold) continue;
      const bboxInput: BBox = [data[o], data[o + 1], data[o + 2], data[o + 3]];
      const bbox = unletterboxBBox(bboxInput, lb, srcW, srcH);
      const landmarks: number[] = [];
      for (let k = 0; k < 10; k += 2) {
        landmarks.push((data[o + 4 + k] - lb.padX) / lb.scale);
        landmarks.push((data[o + 4 + k + 1] - lb.padY) / lb.scale);
      }
      boxes.push({ bbox, score, landmarks });
    }
    return boxes;
  }

  async embedFace(img: Buffer, face: FaceDetection): Promise<Float32Array> {
    const cfg = this.manifest.faceEmbedder;
    if (!cfg) throw new Error('faceEmbedder モデルが未設定です');
    if (!this.embedder) this.embedder = await this.session(cfg.file);
    const sharp = (await import('sharp')).default;
    const meta = await sharp(img).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    // 顔領域を切り出す（範囲をクランプ）。
    const [fx, fy, fw, fh] = face.bbox;
    const left = Math.max(0, Math.min(W - 1, Math.round(fx)));
    const top = Math.max(0, Math.min(H - 1, Math.round(fy)));
    const width = Math.max(1, Math.min(W - left, Math.round(fw)));
    const height = Math.max(1, Math.min(H - top, Math.round(fh)));
    const crop = await sharp(img).extract({ left, top, width, height }).toBuffer();
    const [w, h] = cfg.inputSize;
    const { tensor } = await this.toInputTensor(crop, w, h, (v) => (v - cfg.mean) / cfg.std);
    const feeds: Record<string, any> = { [this.embedder.inputNames[0]]: tensor };
    const results = await this.embedder.run(feeds);
    const emb = results[this.embedder.outputNames[0]].data as Float32Array;
    return l2normalize(Float32Array.from(emb));
  }

  // 品質はヒューリスティック中心(§8): Laplacian 分散=ブレ / 輝度平均=露出。
  async scoreQuality(img: Buffer): Promise<QualityScore> {
    const sharp = (await import('sharp')).default;
    try {
      const gray = sharp(img).removeAlpha().greyscale();
      const stats = await gray.clone().stats();
      const meanLum = (stats.channels[0]?.mean ?? 128) / 255; // 0..1

      // Laplacian で高周波成分の分散を測りブレを推定。
      const { data } = await gray
        .clone()
        .resize(256, 256, { fit: 'inside' })
        .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] })
        .raw()
        .toBuffer({ resolveWithObject: true });
      let mean = 0;
      for (let i = 0; i < data.length; i++) mean += data[i];
      mean /= data.length;
      let variance = 0;
      for (let i = 0; i < data.length; i++) variance += (data[i] - mean) ** 2;
      variance /= data.length;
      const sharpness = clamp01(variance / 500); // 経験的スケール
      // 露出: 中庸(0.5)からの距離が近いほど良い。
      const exposure = clamp01(1 - Math.abs(meanLum - 0.5) * 2);
      const composition = 0.5; // 構図は別モデル。既定中庸。
      const eyesOpen = 0.8;
      const composite = sharpness * 0.4 + exposure * 0.3 + composition * 0.15 + eyesOpen * 0.15;
      return { sharpness, exposure, composition, eyesOpen, composite };
    } catch {
      return { sharpness: 0.5, exposure: 0.5, composition: 0.5, eyesOpen: 0.5, composite: 0.5 };
    }
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** models.json を読み、マニフェストを返す（無ければ null）。 */
export async function loadManifest(modelsDir: string): Promise<ModelManifest | null> {
  try {
    const raw = await fs.readFile(path.join(modelsDir, 'models.json'), 'utf8');
    return JSON.parse(raw) as ModelManifest;
  } catch {
    return null;
  }
}
