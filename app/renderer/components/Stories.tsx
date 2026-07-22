import React, { useEffect, useRef, useState } from 'react';
import { fm } from '../bridge.js';
import type { MediaItem, Story, Timeline } from '../../shared/types.js';

/** 思い出一覧 + 全画面プレイヤー (M4/M5)。 */
export function Stories(): React.ReactElement {
  const [stories, setStories] = useState<Story[]>([]);
  const [playing, setPlaying] = useState<Timeline | null>(null);

  const reload = async (): Promise<void> => setStories(await fm.invoke('stories:list', {}));
  useEffect(() => {
    void reload();
  }, []);

  const build = async (): Promise<void> => {
    await fm.invoke('curation:buildEventStories', {});
    await reload();
  };

  const play = async (storyId: string): Promise<void> => {
    let tl = await fm.invoke('direction:getTimeline', { storyId });
    if (!tl) tl = await fm.invoke('direction:generateTimeline', { storyId });
    setPlaying(tl);
  };

  return (
    <div className="stories">
      <div className="toolbar">
        <button className="btn primary" onClick={build}>
          イベント自動アルバムを作成
        </button>
        <span>{stories.length} 件の思い出</span>
      </div>
      <div className="story-grid">
        {stories.map((s) => (
          <button key={s.id} className="story-card" onClick={() => play(s.id)}>
            <div className="cover" />
            <div className="story-title">{s.title}</div>
            <div className="story-sub">{fmtRange(s.startAt, s.endAt)}</div>
          </button>
        ))}
        {stories.length === 0 && (
          <p className="hint">まだ思い出がありません。解析が終わったら自動アルバムを作成できます。</p>
        )}
      </div>
      {playing && <Player timeline={playing} onClose={() => setPlaying(null)} />}
    </div>
  );
}

/** 全画面プレイヤー。Ken Burns はクリップの矩形を CSS transform で補間して再現する。 */
function Player({ timeline, onClose }: { timeline: Timeline; onClose: () => void }): React.ReactElement {
  const [idx, setIdx] = useState(0);
  const [media, setMedia] = useState<Record<string, MediaItem>>({});
  const [paused, setPaused] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void (async () => {
      const map: Record<string, MediaItem> = {};
      for (const c of timeline.clips) {
        const m = await fm.invoke('media:get', { id: c.mediaId });
        if (m) map[c.mediaId] = m;
      }
      setMedia(map);
    })();
  }, [timeline]);

  useEffect(() => {
    if (paused) return;
    const clip = timeline.clips[idx];
    if (!clip) return;
    timer.current = setTimeout(() => {
      setIdx((i) => (i + 1 < timeline.clips.length ? i + 1 : i));
    }, clip.durationMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [idx, paused, timeline]);

  const clip = timeline.clips[idx];
  const item = clip ? media[clip.mediaId] : undefined;
  const src = item?.previewPath || item?.thumbPath;

  const kb = clip
    ? {
        // 始点→終点の矩形を CSS 変数として渡し、keyframes でズーム/パンする。
        ['--s' as string]: rectToTransform(clip.kbStartRect),
        ['--e' as string]: rectToTransform(clip.kbEndRect),
        animationDuration: `${clip.durationMs}ms`,
      }
    : {};

  return (
    <div className="player" onClick={() => setPaused((p) => !p)}>
      <button className="player-close" onClick={(e) => { e.stopPropagation(); onClose(); }}>
        ✕
      </button>
      <div className="stage">
        {src ? (
          <div
            key={idx}
            className={clip?.transitionIn === 'crossfade' ? 'frame fade' : 'frame'}
            style={{ ...kb, backgroundImage: `url(file://${src})` }}
          />
        ) : (
          <div className="frame placeholder" key={idx}>
            {item ? basename(item.sourceRef) : '…'}
          </div>
        )}
      </div>
      <div className="player-bar" onClick={(e) => e.stopPropagation()}>
        <button className="btn ghost" onClick={() => setIdx((i) => Math.max(0, i - 1))}>
          ⏮
        </button>
        <button className="btn ghost" onClick={() => setPaused((p) => !p)}>
          {paused ? '▶' : '⏸'}
        </button>
        <button
          className="btn ghost"
          onClick={() => setIdx((i) => Math.min(timeline.clips.length - 1, i + 1))}
        >
          ⏭
        </button>
        <span className="counter">
          {idx + 1} / {timeline.clips.length}
        </span>
      </div>
    </div>
  );
}

function rectToTransform(rect: [number, number, number, number]): string {
  const [x, y, w] = rect;
  const scale = 1 / Math.max(0.2, w);
  const tx = -x * 100;
  const ty = -y * 100;
  return `translate(${tx}%, ${ty}%) scale(${scale})`;
}
function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}
function fmtRange(a: number | null, b: number | null): string {
  if (a == null) return '';
  const f = (t: number) => {
    const d = new Date(t);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  };
  return b && b !== a ? `${f(a)} – ${f(b)}` : f(a);
}
