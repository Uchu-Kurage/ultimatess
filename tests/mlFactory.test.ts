// ============================================================================
// MLAdapter 選択ロジック（起動ログ用の説明つき）。
// NodeMLAdapter 本体はネイティブ実行しないが、選択と説明文の生成は検証できる。
// ============================================================================

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { selectMLAdapter } from '../app/core/analysis/mlAdapterFactory.js';

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {});
});

async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'models-'));
  dirs.push(d);
  return d;
}

const MANIFEST = {
  faceDetector: { file: 'det.onnx', inputSize: [320, 320], scoreThreshold: 0.6, nmsThreshold: 0.4, format: 'yunet15' },
  faceEmbedder: { file: 'emb.onnx', inputSize: [112, 112], mean: 127.5, std: 128 },
};

describe('selectMLAdapter', () => {
  it('models.json が無ければ Mock にフォールバック', async () => {
    const d = await tmp();
    const sel = await selectMLAdapter(d);
    expect(sel.adapter.constructor.name).toBe('MockMLAdapter');
    expect(sel.description).toContain('models.json が無い');
  });

  it('検出器/埋め込みの片方しか無ければ Mock', async () => {
    const d = await tmp();
    await fs.writeFile(path.join(d, 'models.json'), JSON.stringify({ faceDetector: MANIFEST.faceDetector }));
    const sel = await selectMLAdapter(d);
    expect(sel.adapter.constructor.name).toBe('MockMLAdapter');
    expect(sel.description).toContain('両方が必要');
  });

  it('マニフェストはあるがモデルファイルが無ければ Mock（理由を明示）', async () => {
    const d = await tmp();
    await fs.writeFile(path.join(d, 'models.json'), JSON.stringify(MANIFEST));
    const sel = await selectMLAdapter(d);
    expect(sel.adapter.constructor.name).toBe('MockMLAdapter');
    expect(sel.description).toContain('モデルファイル未配置');
    expect(sel.description).toContain('det.onnx');
    expect(sel.description).toContain('emb.onnx');
  });

  it('models.json とモデル2ファイルが揃えば NodeMLAdapter', async () => {
    const d = await tmp();
    await fs.writeFile(path.join(d, 'models.json'), JSON.stringify(MANIFEST));
    await fs.writeFile(path.join(d, 'det.onnx'), 'dummy');
    await fs.writeFile(path.join(d, 'emb.onnx'), 'dummy');
    const sel = await selectMLAdapter(d);
    expect(sel.adapter.constructor.name).toBe('NodeMLAdapter');
    expect(sel.description).toContain('NodeMLAdapter');
    expect(sel.description).toContain('det.onnx');
  });
});
