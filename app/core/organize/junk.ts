// ============================================================================
// 不要写真検出 (設計書 v3 §5.5)。
// ボケ・真っ暗/白飛び・スクリーンショット・誤撮影をレビュー提示する提案を作る。
// 破壊はしない（提案のみ・承認後にゴミ箱送り）。純関数でテスト可能。
// ============================================================================

import * as path from 'node:path';
import type { MediaItem, OrganizeProposalItem, QualityScore } from '../../shared/types.js';

export interface JunkThresholds {
  /** composite がこの値未満なら低品質候補。 */
  minComposite: number;
  /** sharpness がこの値未満ならブレ候補。 */
  minSharpness: number;
  /** exposure がこの値未満なら暗すぎ、(1-この値)超で明るすぎ。 */
  exposureMargin: number;
}

export const DEFAULT_JUNK_THRESHOLDS: JunkThresholds = {
  minComposite: 0.35,
  minSharpness: 0.2,
  exposureMargin: 0.08,
};

export interface JunkInput {
  media: MediaItem[];
  qualityOf: (mediaId: string) => QualityScore | null;
  thresholds?: JunkThresholds;
}

function looksLikeScreenshot(m: MediaItem): boolean {
  const name = path.basename(m.sourceRef).toLowerCase();
  if (name.includes('screenshot') || name.includes('screen shot') || name.startsWith('スクリーンショット')) {
    return true;
  }
  return false;
}

/** 不要候補の提案（action='trash'）と理由を返す。 */
export function detectJunk(input: JunkInput): OrganizeProposalItem[] {
  const th = input.thresholds ?? DEFAULT_JUNK_THRESHOLDS;
  const out: OrganizeProposalItem[] = [];
  for (const m of input.media) {
    const reasons: string[] = [];
    if (looksLikeScreenshot(m)) reasons.push('スクリーンショット');
    const q = input.qualityOf(m.id);
    if (q) {
      if (q.sharpness < th.minSharpness) reasons.push('ブレ');
      if (q.exposure < th.exposureMargin) reasons.push('露出不足(暗い)');
      if (q.exposure > 1 - th.exposureMargin) reasons.push('白飛び');
      if (q.composite < th.minComposite && reasons.length === 0) reasons.push('低品質');
    }
    if (reasons.length > 0) {
      out.push({ mediaId: m.id, action: 'trash', reason: reasons.join(' / ') });
    }
  }
  return out;
}
