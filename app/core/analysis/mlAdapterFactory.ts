// ============================================================================
// MLAdapter ファクトリ。app/models/ に実 ONNX モデル + models.json があれば
// NodeMLAdapter を、無ければ MockMLAdapter を返す(§11: モデル確定前はモックで先行)。
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

export async function createMLAdapter(modelsDir: string): Promise<MLAdapter> {
  const manifest = await loadManifest(modelsDir);
  if (manifest?.faceDetector && manifest.faceEmbedder) {
    const detOk = await fileExists(path.join(modelsDir, manifest.faceDetector.file));
    const embOk = await fileExists(path.join(modelsDir, manifest.faceEmbedder.file));
    if (detOk && embOk) return new NodeMLAdapter(modelsDir, manifest);
  }
  // モデル未配置 → 決定論モックで先行。
  return new MockMLAdapter();
}
