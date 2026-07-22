import React from 'react';
import { fm } from '../bridge.js';
import { useJobs } from '../hooks.js';
import { useInitialJobs } from '../hooks.js';

const KIND_LABEL: Record<string, string> = {
  index: '索引',
  analyze: '解析',
  dedup: '重複整理',
  restructure: '物理再配置',
};

/** ジョブ一覧・一時停止/再開/中止 (M6)。 */
export function JobsPanel(): React.ReactElement {
  const live = useJobs();
  const initial = useInitialJobs();

  // 初期一覧にライブ進捗を重ねる。
  const merged = new Map<string, { kind: string; progress: number; total: number; status: string }>();
  for (const j of initial) merged.set(j.id, { kind: j.kind, progress: j.progress, total: j.total, status: j.status });
  for (const [id, e] of live) merged.set(id, { kind: e.kind, progress: e.progress, total: e.total, status: e.status });

  const rows = [...merged.entries()];

  return (
    <div className="jobs-panel">
      <h2>ジョブ</h2>
      {rows.length === 0 && <p className="hint">実行中のジョブはありません。</p>}
      <ul className="job-list">
        {rows.map(([id, j]) => (
          <li key={id} className="job">
            <div className="job-head">
              <span className="job-kind">{KIND_LABEL[j.kind] ?? j.kind}</span>
              <span className={`job-status ${j.status}`}>{j.status}</span>
            </div>
            <div className="progressbar">
              <div
                className="progressfill"
                style={{ width: `${j.total ? Math.round((j.progress / j.total) * 100) : 0}%` }}
              />
            </div>
            <div className="job-meta">
              {j.progress.toLocaleString()} / {j.total.toLocaleString()}
              <span className="job-actions">
                {j.status === 'running' && (
                  <button className="btn tiny" onClick={() => fm.invoke('jobs:pause', { jobId: id })}>
                    一時停止
                  </button>
                )}
                {j.status === 'paused' && (
                  <button className="btn tiny" onClick={() => fm.invoke('jobs:resume', { jobId: id })}>
                    再開
                  </button>
                )}
                {(j.status === 'running' || j.status === 'paused' || j.status === 'queued') && (
                  <button className="btn tiny ghost" onClick={() => fm.invoke('jobs:cancel', { jobId: id })}>
                    中止
                  </button>
                )}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
