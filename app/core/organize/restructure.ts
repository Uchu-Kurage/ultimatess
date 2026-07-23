// ============================================================================
// 安全な移動パイプライン (P1 §7 / 設計書 v3 §5.6) — 本アプリで最もリスクが高い箇所。
//
// 原則:
//  - 非破壊が既定（proposeRestructure はプレビューのみ・原本を一切変えない）
//  - 実行は 1 ファイルずつ。各状態遷移を即コミット（クラッシュ後の再開点）
//  - 同一ドライブ: rename / ドライブ跨ぎ: copy→checksum照合→元をゴミ箱
//  - 完全な物理的可逆性: operation_journal を逆再生して元へ戻す
//  - 他アプリ管理下 root は除外 / 空き容量不足なら安全に中止
// ============================================================================

import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import type {
  MediaItem,
  NamingRule,
  OperationJournalEntry,
  RestructureConflict,
  RestructureItemRow,
  RestructurePlan,
  RestructurePlanItem,
} from '../../shared/types.js';
import { newId, now } from '../../shared/util.js';
import type { FileOpAdapter } from '../fileop/fileOpAdapter.js';
import type { RestructurePlanRow, Store } from '../store/store.js';
import { computeTargetPath, withSequence, type NamingContext } from './naming.js';

export interface RestructureOptions {
  /** 1 件が失敗したとき全体を止めるか（既定: 続行し当該のみ failed）。 */
  stopOnError?: boolean;
  /** media ごとの命名コンテキスト（イベント名/場所名）を解決する。 */
  resolveContext?: (item: MediaItem) => NamingContext;
}

export type ProgressCb = (done: number, total: number) => void;

const REF_TYPE = 'restructure_plan';

export class RestructureEngine {
  constructor(
    private readonly store: Store,
    private readonly fileop: FileOpAdapter,
    private readonly opts: RestructureOptions = {},
  ) {}

  // --------------------------------------------------------------------------
  // 7.1 実行前: プレビュー生成（原本を一切変更しない）
  // --------------------------------------------------------------------------
  async proposeRestructure(targetRoot: string, naming: NamingRule): Promise<RestructurePlan> {
    const planId = newId('plan');
    const items: RestructurePlanItem[] = [];
    const conflicts: RestructureConflict[] = [];
    const rows: RestructureItemRow[] = [];
    const assigned = new Set<string>();
    // ディレクトリ単位でディスク上の既存ファイルをキャッシュし、
    // 100k 件でも per-file の syscall を避ける（新規ライブラリなら実質ゼロ）。
    const dirCache = new DirCache();
    let spaceRequired = 0;

    for (const media of this.store.allMedia()) {
      const root = this.store.getRoot(media.rootId);
      // 他アプリ管理下 root は再配置対象から除外(§2-3 / §7.1-3)。
      if (root?.managedByOtherApp) continue;

      const ctx = this.opts.resolveContext?.(media) ?? { placeName: media.placeName };
      const base = computeTargetPath(media, ctx, naming, targetRoot);

      // 命名衝突（計画内の重複 or 既存ファイル）に連番付与。
      let seq = 0;
      let toPath = base;
      // eslint-disable-next-line no-await-in-loop
      while (assigned.has(toPath) || (await dirCache.exists(toPath))) {
        seq += 1;
        toPath = withSequence(base, seq);
      }
      if (seq > 0) conflicts.push({ mediaId: media.id, toPath });
      assigned.add(toPath);

      const fromPath = media.sourceRef;
      // eslint-disable-next-line no-await-in-loop
      const sameDrive = await this.fileop.sameVolume(fromPath, targetRoot);

      if (!sameDrive) {
        // ドライブ跨ぎ分のみ、ターゲット空き容量にカウント。
        // eslint-disable-next-line no-await-in-loop
        spaceRequired += await fileSize(fromPath);
      }

      items.push({ mediaId: media.id, fromPath, toPath, sameDrive });
      rows.push({
        planId,
        mediaId: media.id,
        fromPath,
        toPath,
        sameDrive,
        state: 'pending',
      });
    }

    const planRow: RestructurePlanRow = {
      id: planId,
      status: 'preview',
      targetRoot,
      spaceRequired,
    };
    this.store.createRestructurePlan(planRow);
    this.store.insertRestructureItems(rows);

    return { id: planId, status: 'preview', targetRoot, spaceRequired, items, conflicts };
  }

  // --------------------------------------------------------------------------
  // 7.2 実行: 1 ファイルずつ・状態機械
  // --------------------------------------------------------------------------
  async applyRestructure(planId: string, onProgress?: ProgressCb): Promise<void> {
    const plan = this.store.getRestructurePlan(planId);
    if (!plan) throw new Error(`plan not found: ${planId}`);
    if (plan.status === 'done') return;

    // 空き容量チェック（ドライブ跨ぎ合計 ≤ ターゲット空き）。不足なら着手前に中止。
    await this.assertEnoughSpace(plan);

    this.store.updateRestructurePlanStatus(planId, 'running');
    await this.drivePlan(planId, onProgress);
  }

  private async assertEnoughSpace(plan: RestructurePlanRow): Promise<void> {
    if (plan.spaceRequired <= 0) return;
    const free = await this.fileop.freeSpace(plan.targetRoot);
    if (free < plan.spaceRequired) {
      this.store.updateRestructurePlanStatus(plan.id, 'failed');
      throw new Error(
        `空き容量不足のため中止: 必要 ${plan.spaceRequired} バイト / 空き ${free} バイト`,
      );
    }
  }

  /** 未完了 item を状態から続行する（新規実行・再開の共通ルート）。 */
  private async drivePlan(planId: string, onProgress?: ProgressCb): Promise<void> {
    const all = this.store.listRestructureItems(planId);
    const total = all.length;
    let done = all.filter((i) => i.state === 'done').length;

    for (const item of all) {
      if (item.state === 'done' || item.state === 'failed') continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.processItem(planId, item);
        done += 1;
        onProgress?.(done, total);
      } catch (err) {
        this.store.updateRestructureItem(planId, item.mediaId, {
          state: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
        if (this.opts.stopOnError) {
          this.store.updateRestructurePlanStatus(planId, 'failed');
          throw err;
        }
      }
    }

    const remaining = this.store.listRestructureItemsByState(planId, [
      'pending',
      'renamed',
      'copied',
      'verified',
      'source_trashed',
    ]);
    const failed = this.store.listRestructureItemsByState(planId, ['failed']);
    if (remaining.length > 0) return; // まだ途中（通常は起きない）
    this.store.updateRestructurePlanStatus(planId, failed.length > 0 ? 'failed' : 'done');
  }

  /**
   * 1 件を現在の state から前進させる。各遷移後に state を即コミットするので、
   * どこでクラッシュしても recoverOnStartup が同じ地点から続行できる。
   */
  private async processItem(planId: string, item: RestructureItemRow): Promise<void> {
    const { mediaId, fromPath, toPath, sameDrive } = item;

    if (sameDrive) {
      // 同一ドライブ: アトミック rename のみ。
      if (item.state === 'pending') {
        await this.fileop.move(fromPath, toPath);
        this.store.updateRestructureItem(planId, mediaId, { state: 'renamed' });
      }
      this.finish(planId, item, 'move');
      return;
    }

    // ドライブ跨ぎ: copy → verify → trash。
    let state = item.state;

    if (state === 'pending') {
      // 途中終了していても .part→rename 方式なので本パスに壊れたファイルは残らない。
      await this.fileop.copy(fromPath, toPath);
      this.store.updateRestructureItem(planId, mediaId, { state: 'copied' });
      state = 'copied';
    }

    if (state === 'copied') {
      const srcSum = await this.fileop.checksum(fromPath);
      const dstSum = await this.fileop.checksum(toPath);
      if (srcSum !== dstSum) {
        // 不一致: コピー先を破棄し、原本は絶対に消さない。
        await safeRemove(toPath);
        throw new Error('チェックサム不一致（原本は保全）');
      }
      this.store.updateRestructureItem(planId, mediaId, { state: 'verified', checksum: dstSum });
      state = 'verified';
    }

    if (state === 'verified') {
      await this.fileop.trash(fromPath);
      this.store.updateRestructureItem(planId, mediaId, { state: 'source_trashed' });
      state = 'source_trashed';
    }

    this.finish(planId, item, 'restructure');
  }

  /** done へ遷移し、source_ref 更新とジャーナル記録を行う。 */
  private finish(planId: string, item: RestructureItemRow, op: 'move' | 'restructure'): void {
    this.store.updateRestructureItem(planId, item.mediaId, { state: 'done' });
    this.store.updateSourceRef(item.mediaId, item.toPath);
    const entry: OperationJournalEntry = {
      id: newId('jrnl'),
      refType: REF_TYPE,
      refId: planId,
      op,
      fromPath: item.fromPath,
      toPath: item.toPath,
      executedAt: now(),
      reversible: true,
    };
    this.store.appendJournal(entry);
  }

  // --------------------------------------------------------------------------
  // 7.3 再開・巻き戻し
  // --------------------------------------------------------------------------
  /** 起動時: 未完 plan を検出し、各 item の state から続行する。 */
  async recoverOnStartup(onProgress?: ProgressCb): Promise<void> {
    const plans = this.store.listRestructurePlansByStatus('running', 'approved');
    for (const plan of plans) {
      // eslint-disable-next-line no-await-in-loop
      await this.drivePlan(plan.id, onProgress);
    }
  }

  /** Undo: ジャーナルを逆順に、to→from へ戻す。 */
  async undo(planId: string): Promise<void> {
    const entries = this.store.listJournalByRef(REF_TYPE, planId);
    // executedAt 昇順で記録されているので逆順に処理。
    entries.sort((a, b) => a.executedAt - b.executedAt);
    for (const e of [...entries].reverse()) {
      if (!e.reversible) continue;
      // eslint-disable-next-line no-await-in-loop
      await this.undoEntry(e);
    }
    this.store.updateRestructurePlanStatus(planId, 'reverted');
  }

  private async undoEntry(e: OperationJournalEntry): Promise<void> {
    if (e.op === 'move') {
      // 同一ドライブ: rename で元へ。
      await this.fileop.move(e.toPath, e.fromPath);
    } else {
      // ドライブ跨ぎ: 原本(ゴミ箱)を復元 → コピー先を破棄。
      if (this.fileop.restoreFromTrash) {
        await this.fileop.restoreFromTrash(e.fromPath);
        await this.fileop.trash(e.toPath);
      } else {
        // 復元 API が無い環境: コピー先から原本位置へ復元し、コピーを破棄。
        await this.fileop.copy(e.toPath, e.fromPath);
        await this.fileop.trash(e.toPath);
      }
    }
    // DB の参照も元へ戻す。
    const media = this.store.getMediaBySourceRef(e.toPath);
    if (media) this.store.updateSourceRef(media.id, e.fromPath);
  }
}

// ---- 小さなヘルパ ----

/**
 * ディレクトリ単位で既存ファイル集合をキャッシュする衝突判定。
 * per-file の fs.access を、per-dir の readdir 1 回に置き換える。
 * 新規ライブラリ（対象ディレクトリが存在しない）なら readdir すら発生しない。
 */
class DirCache {
  private entries = new Map<string, Set<string> | null>(); // null = ディレクトリ非存在

  async exists(filePath: string): Promise<boolean> {
    const dir = nodePath.dirname(filePath);
    const base = nodePath.basename(filePath);
    let set = this.entries.get(dir);
    if (set === undefined) {
      set = await fs
        .readdir(dir)
        .then((names) => new Set(names))
        .catch(() => null);
      this.entries.set(dir, set);
    }
    return set ? set.has(base) : false;
  }
}

async function fileSize(p: string): Promise<number> {
  try {
    const st = await fs.stat(p);
    return st.size;
  } catch {
    return 0;
  }
}

async function safeRemove(p: string): Promise<void> {
  await fs.rm(p, { force: true }).catch(() => {
    /* ignore */
  });
  await fs.rm(`${p}.part`, { force: true }).catch(() => {
    /* ignore */
  });
}

export type { RestructurePlanRow };
