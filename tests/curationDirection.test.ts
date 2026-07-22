import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../app/core/store/inMemoryStore.js';
import { CurationEngine } from '../app/core/curation/curationEngine.js';
import { DirectionEngine } from '../app/core/direction/directionEngine.js';
import type { Face, MediaItem, QualityScore } from '../app/shared/types.js';
import { newId } from '../app/shared/util.js';

function addMedia(store: InMemoryStore, createdAt: number, place?: string): MediaItem {
  const m: MediaItem = {
    id: newId('m'),
    rootId: 'r',
    sourceRef: `/x/${createdAt}.jpg`,
    mediaType: 'photo',
    createdAt,
    dateUncertain: false,
    ...(place ? { placeName: place } : {}),
    width: 4000,
    height: 3000,
    orientation: 1,
    contentHash: 'c' + createdAt,
    perceptualHash: '0000000000000000',
    thumbPath: '',
    previewPath: '',
    analysisStatus: 'done',
  };
  store.upsertMedia(m);
  return m;
}

function setQuality(store: InMemoryStore, id: string, composite: number): void {
  const q: QualityScore = {
    sharpness: composite,
    exposure: 0.5,
    composition: 0.5,
    eyesOpen: 0.5,
    composite,
  };
  store.upsertQuality(id, q);
}

const H = 60 * 60 * 1000;

describe('CurationEngine イベント分割', () => {
  it('6時間超のギャップで別イベントに分かれる', async () => {
    const store = new InMemoryStore();
    const base = Date.UTC(2024, 5, 1, 10, 0, 0);
    addMedia(store, base);
    addMedia(store, base + 1 * H); // 同イベント
    addMedia(store, base + 20 * H); // 別イベント(翌日相当)
    const cur = new CurationEngine(store);
    const ids = await cur.buildEventStories();
    expect(ids).toHaveLength(2);
    const stories = store.listStories();
    expect(stories).toHaveLength(2);
  });

  it('場所が変わると別イベントに分かれる', async () => {
    const store = new InMemoryStore();
    const base = Date.UTC(2024, 5, 1, 10, 0, 0);
    addMedia(store, base, '東京');
    addMedia(store, base + 30 * 60 * 1000, '大阪'); // 30分後だが場所違い
    const cur = new CurationEngine(store);
    const ids = await cur.buildEventStories();
    expect(ids).toHaveLength(2);
  });

  it('cover と hero が品質上位で選ばれる', async () => {
    const store = new InMemoryStore();
    const base = Date.UTC(2024, 5, 1, 10, 0, 0);
    const m1 = addMedia(store, base);
    const m2 = addMedia(store, base + 1000);
    setQuality(store, m1.id, 0.2);
    setQuality(store, m2.id, 0.95);
    const cur = new CurationEngine(store);
    const [storyId] = await cur.buildEventStories({ heroCount: 1 });
    const story = store.getStory(storyId)!;
    expect(story.coverMediaId).toBe(m2.id); // 高品質が表紙
    const heroes = store.listStoryItems(storyId).filter((i) => i.role === 'hero');
    expect(heroes).toHaveLength(1);
    expect(heroes[0].mediaId).toBe(m2.id);
  });
});

describe('DirectionEngine タイムライン生成', () => {
  it('story からクリップを生成し、尺が累積する', async () => {
    const store = new InMemoryStore();
    const base = Date.UTC(2024, 5, 1, 10, 0, 0);
    const m1 = addMedia(store, base);
    const m2 = addMedia(store, base + 1000);
    setQuality(store, m1.id, 0.9);
    setQuality(store, m2.id, 0.1);
    const cur = new CurationEngine(store);
    const [storyId] = await cur.buildEventStories({ heroCount: 1 });

    const dir = new DirectionEngine(store);
    const tl = await dir.generateTimeline(storyId);
    expect(tl.clips).toHaveLength(2);
    expect(tl.clips[0].startMs).toBe(0);
    expect(tl.clips[0].transitionIn).toBe('none');
    expect(tl.clips[1].transitionIn).toBe('crossfade');
    // 2 番目は 1 番目の尺 - トランジション分から開始。
    expect(tl.clips[1].startMs).toBe(
      tl.clips[0].durationMs - tl.config.transitionMs,
    );
    // 永続化されている。
    expect(store.getTimelineByStory(storyId)!.clips).toHaveLength(2);
  });

  it('顔がある写真は顔へズームする Ken Burns 終点になる', async () => {
    const store = new InMemoryStore();
    const m = addMedia(store, Date.UTC(2024, 5, 1, 10, 0, 0));
    setQuality(store, m.id, 0.9);
    const face: Face = {
      id: newId('face'),
      mediaId: m.id,
      bbox: [0.4, 0.3, 0.2, 0.2],
      quality: 0.9,
      eyesOpen: true,
      embedding: new Float32Array(4),
    };
    store.insertFace(face);
    const cur = new CurationEngine(store);
    const [storyId] = await cur.buildEventStories();
    const dir = new DirectionEngine(store);
    const tl = await dir.generateTimeline(storyId);
    const clip = tl.clips[0];
    // 始点は全体、終点は顔寄り（全体より狭い）。
    expect(clip.kbStartRect).toEqual([0, 0, 1, 1]);
    expect(clip.kbEndRect[2]).toBeLessThan(1);
  });
});
