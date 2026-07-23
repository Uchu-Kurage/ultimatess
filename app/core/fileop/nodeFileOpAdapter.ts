import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FileOpAdapter } from './fileOpAdapter.js';

export interface NodeFileOpOptions {
  /**
   * ゴミ箱へ送る関数。既定では 'trash' パッケージを動的 import する。
   * テストでは一時ディレクトリへ退避する実装を注入する。
   */
  trash?: (p: string) => Promise<void>;
  /** ゴミ箱から originalPath へ復元する関数（Undo 用・任意）。 */
  restoreFromTrash?: (originalPath: string) => Promise<void>;
  /** 空き容量取得の差し替え（テスト用）。 */
  freeSpace?: (p: string) => Promise<number>;
}

/**
 * 実ファイルシステム上の FileOpAdapter。
 * - copy は tmp(.part) へ書いてから rename するので、途中終了しても本パスに壊れたファイルを残さない。
 * - trash は差し替え可能（本番=OS ゴミ箱 / テスト=擬似ゴミ箱）。
 */
export class NodeFileOpAdapter implements FileOpAdapter {
  // ディレクトリ→device 番号のキャッシュ。10万件の再配置で per-file の stat を避ける。
  private deviceCache = new Map<string, number>();

  constructor(private readonly opts: NodeFileOpOptions = {}) {}

  async sameVolume(a: string, b: string): Promise<boolean> {
    const da = await this.deviceOf(a);
    const db = await this.deviceOf(b);
    return da === db;
  }

  private async deviceOf(p: string): Promise<number> {
    // 同一ディレクトリ内のファイルは同一 device なので、dir 単位でキャッシュする。
    const dir = path.dirname(path.resolve(p));
    const cached = this.deviceCache.get(dir);
    if (cached !== undefined) return cached;
    // 対象が未作成でも、存在する最も近い親ディレクトリの device を見る。
    let cur = path.resolve(p);
    for (;;) {
      try {
        const st = await fs.stat(cur);
        this.deviceCache.set(dir, st.dev);
        return st.dev;
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) throw new Error(`device not found for ${p}`);
        cur = parent;
      }
    }
  }

  async freeSpace(p: string): Promise<number> {
    if (this.opts.freeSpace) return this.opts.freeSpace(p);
    // Node 22 の fs.statfs を利用（存在する親を探す）。
    let cur = path.resolve(p);
    for (;;) {
      try {
        const st = await fs.statfs(cur);
        return st.bavail * st.bsize;
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) return Number.MAX_SAFE_INTEGER;
        cur = parent;
      }
    }
  }

  async move(from: string, to: string): Promise<void> {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
  }

  async copy(from: string, to: string): Promise<void> {
    await fs.mkdir(path.dirname(to), { recursive: true });
    const tmp = `${to}.part`;
    // 壊れた .part が残っていれば掃除。
    await fs.rm(tmp, { force: true });
    await fs.copyFile(from, tmp);
    // 確実にディスクへ書き出してから本パスへ。
    const fh = await fs.open(tmp, 'r+');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, to);
  }

  checksum(p: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const rs = createReadStream(p);
      rs.on('error', reject);
      rs.on('data', (d) => hash.update(d));
      rs.on('end', () => resolve(hash.digest('hex')));
    });
  }

  async trash(p: string): Promise<void> {
    if (this.opts.trash) return this.opts.trash(p);
    // 本番: OS のゴミ箱へ。ESM の動的 import。
    const mod = (await import('trash')) as unknown as {
      default: (input: string | string[]) => Promise<void>;
    };
    await mod.default(p);
  }

  async restoreFromTrash(originalPath: string): Promise<void> {
    if (this.opts.restoreFromTrash) return this.opts.restoreFromTrash(originalPath);
    throw new Error('restoreFromTrash はこの環境では未対応です');
  }
}
