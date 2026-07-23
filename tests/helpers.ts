import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MediaItem, RootFolder } from '../app/shared/types.js';
import { newId } from '../app/shared/util.js';
import type { FileOpAdapter } from '../app/core/fileop/fileOpAdapter.js';
import { NodeFileOpAdapter } from '../app/core/fileop/nodeFileOpAdapter.js';
import { InMemoryStore } from '../app/core/store/inMemoryStore.js';

export async function tmpDir(prefix = 'fmtest-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeFile(p: string, content: string): Promise<string> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
  return p;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function read(p: string): Promise<string> {
  return fs.readFile(p, 'utf8');
}

/**
 * 一時ディレクトリ上の擬似ゴミ箱を持つ FileOpAdapter を作る。
 * trash: originalPath -> trashDir 内へ退避しマッピングを保持。
 * restoreFromTrash: originalPath へ戻す。
 */
export class TestTrash {
  private map = new Map<string, string>();
  constructor(private readonly trashDir: string) {}

  trash = async (p: string): Promise<void> => {
    await fs.mkdir(this.trashDir, { recursive: true });
    const dest = path.join(this.trashDir, `${newId('t')}__${path.basename(p)}`);
    await fs.rename(p, dest);
    this.map.set(path.resolve(p), dest);
  };

  restoreFromTrash = async (originalPath: string): Promise<void> => {
    const key = path.resolve(originalPath);
    const dest = this.map.get(key);
    if (!dest) throw new Error(`trash に見つかりません: ${originalPath}`);
    await fs.mkdir(path.dirname(originalPath), { recursive: true });
    await fs.rename(dest, originalPath);
    this.map.delete(key);
  };

  count(): number {
    return this.map.size;
  }
}

export interface TestFileOpConfig {
  /** sameVolume の判定を強制する（cross-drive をシミュレート）。 */
  sameVolume?: (a: string, b: string) => boolean;
  /** freeSpace を固定値に（空き容量不足をシミュレート）。 */
  freeSpace?: number;
  /** checksum を差し替え（不一致をシミュレート）。 */
  checksum?: (p: string) => Promise<string>;
}

/** テスト用 FileOpAdapter。実 fs 上で動作しつつ、判定関数を差し替え可能。 */
export function makeFileOp(
  trash: TestTrash,
  cfg: TestFileOpConfig = {},
): FileOpAdapter {
  const base = new NodeFileOpAdapter({
    trash: trash.trash,
    restoreFromTrash: trash.restoreFromTrash,
    freeSpace: cfg.freeSpace != null ? async () => cfg.freeSpace! : undefined,
  });
  if (!cfg.sameVolume && !cfg.checksum) return base;
  // ラッパで一部メソッドだけ差し替える。
  return {
    sameVolume: cfg.sameVolume
      ? async (a, b) => cfg.sameVolume!(a, b)
      : base.sameVolume.bind(base),
    freeSpace: base.freeSpace.bind(base),
    move: base.move.bind(base),
    copy: base.copy.bind(base),
    checksum: cfg.checksum ?? base.checksum.bind(base),
    trash: base.trash.bind(base),
    restoreFromTrash: base.restoreFromTrash?.bind(base),
  };
}

export interface SeedFile {
  /** 原本の絶対パス。 */
  path: string;
  content: string;
  /** EXIF 相当の撮影日時(ms)。 */
  createdAt?: number | null;
}

/**
 * ルートフォルダ + 実ファイル + media_item を InMemoryStore に投入する。
 */
export async function seedMedia(
  store: InMemoryStore,
  rootPath: string,
  files: SeedFile[],
  opts: { managedByOtherApp?: boolean } = {},
): Promise<{ root: RootFolder; media: MediaItem[] }> {
  const root: RootFolder = {
    id: newId('root'),
    path: rootPath,
    isOnline: true,
    managedByOtherApp: opts.managedByOtherApp ?? false,
  };
  store.addRoot(root);
  const media: MediaItem[] = [];
  for (const f of files) {
    await writeFile(f.path, f.content);
    const item: MediaItem = {
      id: newId('m'),
      rootId: root.id,
      sourceRef: f.path,
      mediaType: 'photo',
      createdAt: f.createdAt === undefined ? Date.UTC(2024, 7, 15, 9, 30, 12) : f.createdAt,
      dateUncertain: false,
      width: 4000,
      height: 3000,
      orientation: 1,
      contentHash: 'ch_' + newId(),
      perceptualHash: '0000000000000000',
      thumbPath: '',
      previewPath: '',
      analysisStatus: 'done',
    };
    store.upsertMedia(item);
    media.push(item);
  }
  return { root, media };
}
