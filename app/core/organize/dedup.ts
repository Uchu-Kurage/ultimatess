// ============================================================================
// 重複・近似重複のグループ化 (設計書 v3 §5.5 / P1 M2)。
// - 完全重複: content_hash 一致。
// - 近似重複: 知覚ハッシュ(BK-tree)でハミング距離近傍を探索。
// 代表 1 枚（最高品質）を残し、他をゴミ箱候補にする提案の素を作る。
// ============================================================================

import type { DuplicateGroup, MediaItem } from '../../shared/types.js';
import { newId, now } from '../../shared/util.js';
import { BKTree } from '../ann/bkTree.js';

export interface DedupInput {
  media: MediaItem[];
  /** media_id -> composite 品質スコア（高いほど良い）。無ければ 0。 */
  qualityOf?: (mediaId: string) => number;
  /** 近似重複とみなすハミング距離の上限。 */
  maxHamming?: number;
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export function buildDuplicateGroups(input: DedupInput): DuplicateGroup[] {
  const { media } = input;
  const maxHamming = input.maxHamming ?? 6;
  const qualityOf = input.qualityOf ?? (() => 0);
  const uf = new UnionFind();
  const byId = new Map(media.map((m) => [m.id, m]));

  // 完全重複: content_hash でまとめる。
  const byContent = new Map<string, string[]>();
  for (const m of media) {
    if (!m.contentHash) continue;
    const arr = byContent.get(m.contentHash) ?? [];
    arr.push(m.id);
    byContent.set(m.contentHash, arr);
  }
  for (const ids of byContent.values()) {
    for (let i = 1; i < ids.length; i++) uf.union(ids[0], ids[i]);
  }

  // 近似重複: 知覚ハッシュ BK-tree。
  const tree = new BKTree();
  for (const m of media) {
    if (!m.perceptualHash) continue;
    const near = tree.near(m.perceptualHash, maxHamming);
    for (const otherId of near) uf.union(m.id, otherId);
    tree.add(m.id, m.perceptualHash);
  }

  // root -> メンバー集約。単独（重複なし）は除外。
  const groups = new Map<string, string[]>();
  for (const m of media) {
    const root = uf.find(m.id);
    const arr = groups.get(root) ?? [];
    arr.push(m.id);
    groups.set(root, arr);
  }

  const out: DuplicateGroup[] = [];
  for (const memberIds of groups.values()) {
    if (memberIds.length < 2) continue;
    // 代表 = 最高品質（同点は先勝ち）。
    let repId = memberIds[0];
    let repQ = qualityOf(repId);
    for (const id of memberIds) {
      const q = qualityOf(id);
      if (q > repQ) {
        repQ = q;
        repId = id;
      }
    }
    const groupId = newId('dup');
    out.push({
      id: groupId,
      createdAt: now(),
      members: memberIds
        .filter((id) => byId.has(id))
        .map((id) => ({ groupId, mediaId: id, isRepresentative: id === repId })),
    });
  }
  return out;
}
