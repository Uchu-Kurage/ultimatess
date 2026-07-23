import { useEffect, useRef, useState } from 'react';
import { fm } from './bridge.js';
import type { JobProgressEvent } from '../shared/ipc.js';
import type { Job } from '../shared/types.js';

/** core の job:progress を購読し、進行中ジョブのマップを返す。 */
export function useJobs(): Map<string, JobProgressEvent> {
  const [jobs, setJobs] = useState<Map<string, JobProgressEvent>>(new Map());
  useEffect(() => {
    const off = fm.on('job:progress', (e) => {
      setJobs((prev) => {
        const next = new Map(prev);
        next.set(e.jobId, e);
        return next;
      });
    });
    return off;
  }, []);
  return jobs;
}

/** 初回に jobs:list を取得しておく（履歴表示用）。 */
export function useInitialJobs(): Job[] {
  const [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => {
    void fm.invoke('jobs:list', {}).then(setJobs);
  }, []);
  return jobs;
}

/** マウント時に一度だけ非同期ロードする小ヘルパ。 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): [T | undefined, () => void] {
  const [value, setValue] = useState<T>();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    void fnRef.current().then((v) => {
      if (alive) setValue(v);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return [value, () => setNonce((n) => n + 1)];
}
