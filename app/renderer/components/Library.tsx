import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fm } from '../bridge.js';
import type { MediaItem, RootFolder } from '../../shared/types.js';

const ROW_H = 88;
const PAGE = 200;

/**
 * 仮想化ライブラリ (M5)。10万件でも可視分のみ描画する。
 * 総数だけ先に取得し、スクロール位置に応じてページをオンデマンド取得する。
 */
export function Library({ roots }: { roots: RootFolder[] }): React.ReactElement {
  const [total, setTotal] = useState(0);
  const [rootId, setRootId] = useState<string | undefined>(undefined);
  const cache = useRef<Map<number, MediaItem>>(new Map());
  const loading = useRef<Set<number>>(new Set());
  const [, force] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportH, setViewportH] = useState(600);

  useEffect(() => {
    cache.current.clear();
    void fm.invoke('media:list', { offset: 0, limit: 1, rootId }).then((r) => setTotal(r.total));
  }, [rootId]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
  }, []);

  const ensurePage = useCallback(
    async (page: number) => {
      const offset = page * PAGE;
      if (loading.current.has(page) || cache.current.has(offset)) return;
      loading.current.add(page);
      const r = await fm.invoke('media:list', { offset, limit: PAGE, rootId });
      r.items.forEach((it, i) => cache.current.set(offset + i, it));
      loading.current.delete(page);
      force((n) => n + 1);
    },
    [rootId],
  );

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
  const end = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_H) + 5);

  useEffect(() => {
    for (let p = Math.floor(start / PAGE); p <= Math.floor(Math.max(start, end - 1) / PAGE); p++) {
      void ensurePage(p);
    }
  }, [start, end, ensurePage]);

  const rows: React.ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const item = cache.current.get(i);
    rows.push(
      <div key={i} className="lib-row" style={{ top: i * ROW_H, height: ROW_H }}>
        <div className="thumb" style={thumbStyle(item)} />
        <div className="meta">
          {item ? (
            <>
              <div className="name">{basename(item.sourceRef)}</div>
              <div className="sub">
                {item.mediaType === 'video' ? '🎬 ' : '🖼 '}
                {fmtDate(item.createdAt)}
                {item.dateUncertain ? ' (日付不確実)' : ''}
                {item.analysisStatus !== 'done' ? ` · 解析:${item.analysisStatus}` : ''}
              </div>
            </>
          ) : (
            <div className="name dim">読み込み中…</div>
          )}
        </div>
      </div>,
    );
  }

  return (
    <div className="library">
      <div className="toolbar">
        <span>{total.toLocaleString()} 件</span>
        <select value={rootId ?? ''} onChange={(e) => setRootId(e.target.value || undefined)}>
          <option value="">すべてのフォルダ</option>
          {roots.map((r) => (
            <option key={r.id} value={r.id}>
              {basename(r.path)}
            </option>
          ))}
        </select>
      </div>
      <div
        className="viewport"
        ref={viewportRef}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      >
        <div className="spacer" style={{ height: total * ROW_H }}>
          {rows}
        </div>
      </div>
    </div>
  );
}

function thumbStyle(item?: MediaItem): React.CSSProperties {
  if (item?.thumbPath) return { backgroundImage: `url(file://${item.thumbPath})` };
  return {};
}
function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}
function fmtDate(ts: number | null): string {
  if (ts == null) return '日付なし';
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
