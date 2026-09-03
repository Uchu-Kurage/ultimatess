// ============================================================================
// キュレーションエンジン (設計書 v3 §5.7 / P1 M4)。
// イベント境界検出（時間×場所×人物）／ベストショット選抜・重複間引き。
// LLM 有効時は自然文見出し、非対応時はヒューリスティック見出し(§2-6, §7.5)。
// ============================================================================

import type { MediaItem, Story, StoryItem } from '../../shared/types.js';
import { newId } from '../../shared/util.js';
import type { Store } from '../store/store.js';

export interface PersonStoryOptions {
  /** 1 人物あたり最低この枚数がないとストーリー化しない。 */
  minPhotos?: number;
  heroCount?: number;
}

export interface CurationOptions {
  /** イベント境界とみなす時間ギャップ(ms)。既定 6 時間。 */
  gapMs?: number;
  /** 1 イベントで hero に選ぶ最大枚数。 */
  heroCount?: number;
}

const SIX_HOURS = 6 * 60 * 60 * 1000;

export class CurationEngine {
  constructor(private readonly store: Store) {}

  /** イベント自動アルバムを生成し、作成した story id を返す。 */
  async buildEventStories(opts: CurationOptions = {}): Promise<string[]> {
    const gapMs = opts.gapMs ?? SIX_HOURS;
    const heroCount = opts.heroCount ?? 3;

    // 再実行で重複を作らないよう、既存のイベントストーリーを一旦クリアしてから作り直す。
    this.store.deleteStoriesByKind('event');

    const dated = this.store
      .allMedia()
      .filter((m) => m.createdAt != null)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

    const events = this.splitIntoEvents(dated, gapMs);
    const ids: string[] = [];
    for (const members of events) {
      if (members.length === 0) continue;
      const id = this.materializeStory(members, heroCount);
      ids.push(id);
    }
    return ids;
  }

  /** 時間ギャップ or 場所変化でイベントを分割する。 */
  splitIntoEvents(sorted: MediaItem[], gapMs: number): MediaItem[][] {
    const events: MediaItem[][] = [];
    let cur: MediaItem[] = [];
    let prev: MediaItem | null = null;
    for (const m of sorted) {
      if (prev) {
        const gap = (m.createdAt ?? 0) - (prev.createdAt ?? 0);
        const placeChanged =
          !!m.placeName && !!prev.placeName && m.placeName !== prev.placeName;
        if (gap > gapMs || placeChanged) {
          events.push(cur);
          cur = [];
        }
      }
      cur.push(m);
      prev = m;
    }
    if (cur.length) events.push(cur);
    return events;
  }

  private materializeStory(members: MediaItem[], heroCount: number): string {
    const startAt = members[0].createdAt ?? null;
    const endAt = members[members.length - 1].createdAt ?? null;
    const placeName = mostCommonPlace(members);
    const title = this.makeTitle(startAt, placeName, members.length);

    // ベストショット選抜: 品質 composite 降順。上位を hero、残りを support。
    const ranked = [...members].sort(
      (a, b) => (this.qualityOf(b.id) ?? 0) - (this.qualityOf(a.id) ?? 0),
    );
    const storyId = newId('story');
    const story: Story = {
      id: storyId,
      title,
      kind: 'event',
      startAt,
      endAt,
      ...(placeName ? { placeName } : {}),
      coverMediaId: ranked[0]?.id,
    };
    this.store.createStory(story);

    // StoryItem は時系列で並べ、上位品質を hero に。
    const heroSet = new Set(ranked.slice(0, heroCount).map((m) => m.id));
    const items: StoryItem[] = members.map((m, i) => ({
      storyId,
      mediaId: m.id,
      order: i,
      role: heroSet.has(m.id) ? 'hero' : 'support',
    }));
    this.store.replaceStoryItems(storyId, items);
    return storyId;
  }

  /**
   * 人物別ストーリー(§B-5)。名前付き人物ごとに、その人物が写る写真を
   * 期間で束ねてストーリー化し、P1 同様ベストショット選抜を適用する。
   */
  async buildPersonStories(opts: PersonStoryOptions = {}): Promise<string[]> {
    const minPhotos = opts.minPhotos ?? 5;
    const heroCount = opts.heroCount ?? 3;

    // 再実行で重複を作らないよう、既存の人物ストーリーを一旦クリアしてから作り直す。
    this.store.deleteStoriesByKind('person');

    // cluster_id -> その人物が写る mediaId 集合
    const mediaByCluster = new Map<string, Set<string>>();
    for (const f of this.store.listAllFaces()) {
      if (!f.clusterId) continue;
      const set = mediaByCluster.get(f.clusterId) ?? new Set<string>();
      set.add(f.mediaId);
      mediaByCluster.set(f.clusterId, set);
    }

    const ids: string[] = [];
    for (const person of this.store.listActivePersons()) {
      if (!person.displayName) continue; // 名前付きのみ
      const mediaIds = mediaByCluster.get(person.clusterId);
      if (!mediaIds || mediaIds.size < minPhotos) continue;

      const members = [...mediaIds]
        .map((id) => this.store.getMedia(id))
        .filter((m): m is MediaItem => m != null)
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      if (members.length < minPhotos) continue;

      const storyId = newId('story');
      const ranked = [...members].sort(
        (a, b) => (this.qualityOf(b.id) ?? 0) - (this.qualityOf(a.id) ?? 0),
      );
      const heroSet = new Set(ranked.slice(0, heroCount).map((m) => m.id));
      const story: Story = {
        id: storyId,
        title: `${person.displayName}の思い出`,
        kind: 'person',
        startAt: members[0].createdAt ?? null,
        endAt: members[members.length - 1].createdAt ?? null,
        coverMediaId: ranked[0]?.id,
      };
      this.store.createStory(story);
      const items: StoryItem[] = members.map((m, i) => ({
        storyId,
        mediaId: m.id,
        order: i,
        role: heroSet.has(m.id) ? 'hero' : 'support',
      }));
      this.store.replaceStoryItems(storyId, items);
      ids.push(storyId);
    }
    return ids;
  }

  private qualityOf(mediaId: string): number | null {
    return this.store.getQuality(mediaId)?.composite ?? null;
  }

  /** ヒューリスティック見出し（LLM 非対応時のフォールバック書式 §12-5）。 */
  private makeTitle(startAt: number | null, place: string | undefined, count: number): string {
    if (startAt == null) return place ? `${place}の思い出` : '思い出';
    const d = new Date(startAt);
    const dateStr = `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
    if (place) return `${dateStr} ${place}`;
    return `${dateStr}の思い出（${count}枚）`;
  }
}

function mostCommonPlace(members: MediaItem[]): string | undefined {
  const counts = new Map<string, number>();
  for (const m of members) {
    if (m.placeName) counts.set(m.placeName, (counts.get(m.placeName) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [p, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = p;
    }
  }
  return best;
}
