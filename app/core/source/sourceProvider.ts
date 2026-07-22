// ============================================================================
// SourceProvider (設計書 v3 §5.1 / P1 §6)。写真ソースの抽象化。
// 原本は参照のみ。安定 ID と更新検出用の mtime/size で差分同期する。
// ============================================================================

import { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RootFolder } from '../../shared/types.js';

export interface ScannedFile {
  path: string;
  mtime: number;
  size: number;
}

export interface SourceProvider {
  id: string;
  scan(root: RootFolder): AsyncIterable<ScannedFile>;
  isOnline(root: RootFolder): Promise<boolean>;
  read(path: string): Promise<Buffer>;
}

const PHOTO_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.tif', '.tiff', '.bmp', '.dng',
]);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.3gp']);

export function mediaTypeForExt(ext: string): 'photo' | 'video' | null {
  const e = ext.toLowerCase();
  if (PHOTO_EXT.has(e)) return 'photo';
  if (VIDEO_EXT.has(e)) return 'video';
  return null;
}

/**
 * 他アプリ管理下フォルダの検出 (§2-3)。
 * Apple Photos(.photoslibrary) / Lightroom カタログ等を含むパスを判定。
 */
export function looksManagedByOtherApp(p: string): boolean {
  const lower = p.toLowerCase();
  return (
    lower.includes('.photoslibrary') ||
    lower.includes('.photolibrary') ||
    lower.includes('lightroom') ||
    lower.endsWith('.lrcat') ||
    lower.includes('.aplibrary')
  );
}

/** ローカル/外付けフォルダ共通のプロバイダ。外付けは isOnline で接続状態を追跡。 */
export class LocalFolderProvider implements SourceProvider {
  readonly id = 'local';

  async *scan(root: RootFolder): AsyncIterable<ScannedFile> {
    yield* this.walk(root.path);
  }

  private async *walk(dir: string): AsyncIterable<ScannedFile> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 読めないディレクトリはスキップ
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // 他アプリ管理下ライブラリの内部は走査しない（誤って対象化しない）。
        if (looksManagedByOtherApp(full)) continue;
        yield* this.walk(full);
      } else if (ent.isFile()) {
        if (mediaTypeForExt(path.extname(ent.name)) == null) continue;
        try {
          const st = await fs.stat(full);
          yield { path: full, mtime: st.mtimeMs, size: st.size };
        } catch {
          /* 消えたファイル等は無視 */
        }
      }
    }
  }

  async isOnline(root: RootFolder): Promise<boolean> {
    try {
      await fs.access(root.path);
      return true;
    } catch {
      return false;
    }
  }

  read(p: string): Promise<Buffer> {
    return fs.readFile(p);
  }
}
