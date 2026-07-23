// ============================================================================
// 整理エンジン (設計書 v3 §5.5 / P1 §6)。★売りの中核。
// 全操作は 提案 → プレビュー → 承認 → 実行 → 記録（可逆）。
// dedup/junk 提案、ゴミ箱送り、物理再配置(RestructureEngine)、Undo を束ねる。
// ============================================================================

import type {
  FolderDiffNode,
  MediaItem,
  NamingRule,
  NamingTemplate,
  OperationJournalEntry,
  OrganizeProposal,
  RestructurePlan,
  SpaceReport,
} from '../../shared/types.js';
import { DEFAULT_NAMING_RULE } from '../../shared/types.js';
import { newId, now } from '../../shared/util.js';
import type { FileOpAdapter } from '../fileop/fileOpAdapter.js';
import type { Store } from '../store/store.js';
import { buildFolderDiff } from './folderDiff.js';
import { detectJunk } from './junk.js';
import { RestructureEngine, type ProgressCb, type RestructureOptions } from './restructure.js';
import { buildSpaceReport } from './spaceReport.js';
import { computeTemplatePath, type TemplateContext } from './templateNaming.js';

const REF_TYPE_PROPOSAL = 'organize_proposal';

export class OrganizeEngine {
  private readonly restructure: RestructureEngine;
  /** セッション内の提案キャッシュ（承認実行のために保持）。 */
  private proposals = new Map<string, OrganizeProposal>();

  constructor(
    private readonly store: Store,
    private readonly fileop: FileOpAdapter,
    restructureOpts: RestructureOptions = {},
  ) {
    this.restructure = new RestructureEngine(store, fileop, restructureOpts);
  }

  // ---- 提案 ----
  async proposeDedup(): Promise<OrganizeProposal> {
    const groups = this.store.listDuplicateGroups();
    const items = groups.flatMap((g) =>
      g.members.map((m) => ({
        mediaId: m.mediaId,
        action: m.isRepresentative ? ('keep' as const) : ('trash' as const),
        reason: m.isRepresentative ? '代表として保持' : '重複のため',
      })),
    );
    const proposal: OrganizeProposal = { id: newId('prop'), kind: 'dedup', items };
    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  async proposeJunk(): Promise<OrganizeProposal> {
    const media = this.store.allMedia();
    const items = detectJunk({ media, qualityOf: (id) => this.store.getQuality(id) });
    const proposal: OrganizeProposal = { id: newId('prop'), kind: 'junk', items };
    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  proposeRestructure(targetRoot: string, naming: NamingRule): Promise<RestructurePlan> {
    return this.restructure.proposeRestructure(targetRoot, naming);
  }

  // ---- P2 §C: 高度な再配置（テンプレート / アーカイブ） ----

  /**
   * 命名テンプレートで再配置プランを生成(§C-1)。to_path の決め方だけが変わり、
   * 実行・Undo・再開は P1 と同じ安全パイプラインを使う。
   */
  proposeRestructureTemplate(
    targetRoot: string,
    template: NamingTemplate,
    resolveCtx?: (item: MediaItem) => TemplateContext,
  ): Promise<RestructurePlan> {
    const engine = new RestructureEngine(this.store, this.fileop, {
      resolveTargetPath: (item, root) =>
        computeTemplatePath(item, resolveCtx?.(item) ?? { place: item.placeName }, template, root),
    });
    return engine.proposeRestructure(targetRoot, DEFAULT_NAMING_RULE);
  }

  /**
   * 外付けアーカイブのプラン(§C-3)。指定年の原本を外付けへ移すが、
   * 派生キャッシュ(thumb/preview)は PC に残るため未接続でも一覧・再生は動く。
   * 移動には P1 の安全パイプラインをそのまま再利用する。
   */
  proposeArchive(year: string, targetRoot: string): Promise<RestructurePlan> {
    const engine = new RestructureEngine(this.store, this.fileop, {
      filter: (item) =>
        item.createdAt != null && String(new Date(item.createdAt).getUTCFullYear()) === year,
    });
    return engine.proposeRestructure(targetRoot, DEFAULT_NAMING_RULE);
  }

  /** Before/After フォルダ差分(§C-2)。 */
  folderDiff(plan: RestructurePlan): FolderDiffNode {
    return buildFolderDiff(plan.items, plan.targetRoot);
  }

  /** 保存済みプラン ID から Before/After 差分を作る。 */
  folderDiffByPlanId(planId: string): FolderDiffNode {
    const plan = this.store.getRestructurePlan(planId);
    if (!plan) throw new Error(`plan not found: ${planId}`);
    const items = this.store.listRestructureItems(planId).map((i) => ({
      mediaId: i.mediaId,
      fromPath: i.fromPath,
      toPath: i.toPath,
      sameDrive: i.sameDrive,
    }));
    return buildFolderDiff(items, plan.targetRoot);
  }

  /** 回収可能容量レポート(§C-3)。 */
  spaceReport(): Promise<SpaceReport> {
    return buildSpaceReport(this.store);
  }

  // ---- 実行 ----
  /** 承認された提案の trash 対象をゴミ箱へ送る（可逆・ジャーナル記録）。 */
  async applyProposal(proposalId: string, onProgress?: ProgressCb): Promise<void> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
    const targets = proposal.items.filter((i) => i.action === 'trash');
    let done = 0;
    for (const it of targets) {
      const media = this.store.getMedia(it.mediaId);
      if (!media) {
        done += 1;
        continue;
      }
      const from = media.sourceRef;
      await this.fileop.trash(from);
      const entry: OperationJournalEntry = {
        id: newId('jrnl'),
        refType: REF_TYPE_PROPOSAL,
        refId: proposalId,
        op: 'trash',
        fromPath: from,
        toPath: '',
        executedAt: now(),
        reversible: true,
      };
      this.store.appendJournal(entry);
      done += 1;
      onProgress?.(done, targets.length);
    }
  }

  applyRestructure(planId: string, onProgress?: ProgressCb): Promise<void> {
    return this.restructure.applyRestructure(planId, onProgress);
  }

  // ---- Undo / 復旧 ----
  /** journalRef が再配置 plan なら plan を巻き戻し、提案なら trash を復元する。 */
  async undo(journalRef: string): Promise<void> {
    if (this.store.getRestructurePlan(journalRef)) {
      await this.restructure.undo(journalRef);
      return;
    }
    const entries = this.store.listJournalByRef(REF_TYPE_PROPOSAL, journalRef);
    for (const e of [...entries].reverse()) {
      if (e.op !== 'trash' || !e.reversible) continue;
      if (this.fileop.restoreFromTrash) await this.fileop.restoreFromTrash(e.fromPath);
    }
  }

  /** 起動時: 中断された再配置 plan を再開/巻き戻し(§7.3)。 */
  recoverOnStartup(onProgress?: ProgressCb): Promise<void> {
    return this.restructure.recoverOnStartup(onProgress);
  }

  listMediaForReview(): MediaItem[] {
    return this.store.allMedia();
  }
}
