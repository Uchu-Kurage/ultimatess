import React from 'react';
import type { JobProgressEvent } from '../../shared/ipc.js';

/** 画面下部の常駐進捗バー。実行中ジョブがあるときだけ出す。 */
export function JobBar({ jobs }: { jobs: Map<string, JobProgressEvent> }): React.ReactElement | null {
  const active = [...jobs.values()].filter((j) => j.status === 'running' || j.status === 'paused');
  if (active.length === 0) return null;
  return (
    <footer className="jobbar">
      {active.map((j) => (
        <div key={j.jobId} className="jobbar-item">
          <span>{j.kind}</span>
          <div className="progressbar mini">
            <div
              className="progressfill"
              style={{ width: `${j.total ? Math.round((j.progress / j.total) * 100) : 0}%` }}
            />
          </div>
          <span className="pct">
            {j.total ? Math.round((j.progress / j.total) * 100) : 0}%
          </span>
        </div>
      ))}
    </footer>
  );
}
