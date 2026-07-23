// ============================================================================
// 整理エンジン (設計書 v3 §5.5 / P1 §6)。★売りの中核。
// 全操作は 提案 → プレビュー → 承認 → 実行 → 記録（可逆）。
// dedup/junk 提案、ゴミ箱送り、物理再配置(RestructureEngine)、Undo を束ねる。
// ============================================================================

import type {
  MediaItem,
  NamingRule,
  OperationJournalEntry,
  OrganizeProposal,
  RestructurePlan,
} from '../../shared/types.js';
import { newId, now } from '../../shared/util.js';
import type { FileOpAdapter } from '../fileop/fileOpAdapter.js';
import type { Store } from '../store/store.js';
import { detectJunk } from './junk.js';
import { RestructureEngine, type ProgressCb, type RestructureOptions } from './restructure.js';

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
