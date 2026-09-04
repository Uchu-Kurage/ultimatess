// ============================================================================
// MLAdapter ファクトリ。app/models/ に実 ONNX モデル + models.json があれば
// NodeMLAdapter を、無ければ MockMLAdapter を返す(§11: モデル確定前はモックで先行)。
// 起動ログで「どちらを使うか / なぜフォールバックしたか」を説明できるよう
// description も一緒に返す。
// ============================================================================

import { access } from 'node:fs/promises';
import * as path from 'node:path';
import type { MLAdapter } from './mlAdapter.js';
import { MockMLAdapter } from './mlAdapter.js';
import { NodeMLAdapter, loadManifest } from './nodeMLAdapter.js';

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export interface MLAdapterSelection {
  adapter: MLAdapter;
  /** 起動ログ用の人間可読な説明。 */
  description: string;
}

export async function selectMLAdapter(modelsDir: string): Promise<MLAdapterSelection> {
  const manifest = await loadManifest(modelsDir);
  if (!manifest) {
    return {
      adapter: new MockMLAdapter(),
      description: `MockMLAdapter（決定論モック）: ${path.join(modelsDir, 'models.json')} が無いためフォールバック`,
    };
  }
  if (!manifest.faceDetector || !manifest.faceEmbedder) {
    return {
      adapter: new MockMLAdapter(),
      description:
        'MockMLAdapter（決定論モック）: models.json に faceDetector / faceEmbedder の両方が必要',
    };
  }
  const detFile = path.join(modelsDir, manifest.faceDetector.file);
  const embFile = path.join(modelsDir, manifest.faceEmbedder.file);
  const detOk = await fileExists(detFile);
  const embOk = await fileExists(embFile);
  if (detOk && embOk) {
    return {
      adapter: new NodeMLAdapter(modelsDir, manifest),
      description: `NodeMLAdapter（ONNX）: detector=${manifest.faceDetector.file}, embedder=${manifest.faceEmbedder.file}`,
    };
  }
  const missing = [!detOk ? manifest.faceDetector.file : null, !embOk ? manifest.faceEmbedder.file : null]
    .filter(Boolean)
    .join(', ');
  return {
    adapter: new MockMLAdapter(),
    description: `MockMLAdapter（決定論モック）: モデルファイル未配置（${missing}）のためフォールバック`,
  };
}

/** 後方互換: アダプタのみが欲しい呼び出し向け。 */
export async function createMLAdapter(modelsDir: string): Promise<MLAdapter> {
  return (await selectMLAdapter(modelsDir)).adapter;
}
