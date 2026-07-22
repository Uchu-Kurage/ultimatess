// ============================================================================
// 演出エンジン (設計書 v3 §5.8 / P1 M4)。
// Ken Burns 自動（顔/サリエンシー基準）／表示尺・トランジション／
// 写真↔動画混在 → タイムライン生成。純ロジックなのでテスト可能。
// ============================================================================

import type {
  Rect,
  Timeline,
  TimelineClip,
  TimelineConfig,
  TransitionKind,
} from '../../shared/types.js';
import { newId, now } from '../../shared/util.js';
import type { Store } from '../store/store.js';

export interface GenerateOptions {
  musicTrackId?: string;
  config?: Partial<TimelineConfig>;
}

const DEFAULT_CONFIG: TimelineConfig = {
  baseDurationMs: 4000,
  transition: 'crossfade',
  transitionMs: 600,
  kenBurns: true,
};

export class DirectionEngine {
  constructor(private readonly store: Store) {}

  async generateTimeline(storyId: string, opts: GenerateOptions = {}): Promise<Timeline> {
    const story = this.store.getStory(storyId);
    if (!story) throw new Error(`story not found: ${storyId}`);
    const config: TimelineConfig = { ...DEFAULT_CONFIG, ...opts.config };

    const items = this.store.listStoryItems(storyId).sort((a, b) => a.order - b.order);
    const timelineId = newId('timeline');
    const clips: TimelineClip[] = [];
    let cursor = 0;

    for (let i = 0; i < items.length; i++) {
      const media = this.store.getMedia(items[i].mediaId);
      if (!media) continue;

      const duration = this.durationFor(media.mediaType, media.durationMs, items[i].role, config);
      const [kbStart, kbEnd] = config.kenBurns
        ? this.kenBurnsRects(media.id, media.mediaType)
        : ([[0, 0, 1, 1], [0, 0, 1, 1]] as [Rect, Rect]);

      const transitionIn: TransitionKind = i === 0 ? 'none' : config.transition;
      // 2 枚目以降はトランジション分だけ前クリップと重ねて開始する。
      if (i > 0 && transitionIn !== 'none') cursor -= config.transitionMs;

      clips.push({
        timelineId,
        mediaId: media.id,
        order: i,
        startMs: cursor,
        durationMs: duration,
        kbStartRect: kbStart,
        kbEndRect: kbEnd,
        transitionIn,
      });
      cursor += duration;
    }

    const timeline: Timeline = {
      id: timelineId,
      storyId,
      generatedAt: now(),
      ...(opts.musicTrackId ? { musicTrackId: opts.musicTrackId } : {}),
      config,
      clips,
    };
    this.store.upsertTimeline(timeline);
    return timeline;
  }

  /** hero は少し長く、動画は実尺（上限あり）。 */
  private durationFor(
    type: 'photo' | 'video',
    durationMs: number | undefined,
    role: 'hero' | 'support',
    config: TimelineConfig,
  ): number {
    if (type === 'video' && durationMs) {
      return Math.min(durationMs, 12000);
    }
    const base = config.baseDurationMs;
    return role === 'hero' ? Math.round(base * 1.3) : base;
  }

  /**
   * Ken Burns の始点/終点矩形。顔があればその領域へ寄せる。
   * 無ければ中央から緩やかにズームイン。矩形は 0..1 正規化。
   */
  private kenBurnsRects(mediaId: string, type: 'photo' | 'video'): [Rect, Rect] {
    if (type === 'video') {
      // 動画はパン/ズームしない（フルフレーム）。
      return [[0, 0, 1, 1], [0, 0, 1, 1]];
    }
    const faces = this.store.listFacesByMedia(mediaId);
    if (faces.length > 0) {
      // 最大の顔にズームイン。
      const f = faces.reduce((a, b) => (rectArea(b.bbox) > rectArea(a.bbox) ? b : a));
      const [fx, fy, fw, fh] = f.bbox;
      // 顔を中心にした 1.6 倍程度の枠を終点に。
      const pad = 1.6;
      const w = clamp01(fw * pad);
      const h = clamp01(fh * pad);
      const x = clamp01(fx + fw / 2 - w / 2);
      const y = clamp01(fy + fh / 2 - h / 2);
      const start: Rect = [0, 0, 1, 1];
      const end: Rect = [x, y, Math.max(0.3, w), Math.max(0.3, h)];
      return [start, end];
    }
    // 顔なし: 全体 → やや寄り。
    return [[0, 0, 1, 1], [0.08, 0.08, 0.84, 0.84]];
  }
}

function rectArea(r: Rect): number {
  return r[2] * r[3];
}
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
