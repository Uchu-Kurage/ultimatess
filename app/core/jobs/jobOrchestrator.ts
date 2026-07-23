// ============================================================================
// ジョブ基盤 (設計書 v3 §5.9 / P1 §6) ★10万規模で必須。
// 長時間・再開可能・一時停止可能なバッチジョブ（索引/解析/整理）を統括する。
// - 進捗を Store に永続化し、クラッシュ後は recoverOnStartup で続行。
// - pause/resume/cancel は協調的（ハンドラが checkpoint で応じる）。
// ============================================================================

import type { Job, JobKind, JobStatus } from '../../shared/types.js';
import { newId, now } from '../../shared/util.js';
import type { Store } from '../store/store.js';

export interface JobSignal {
  paused(): boolean;
  cancelled(): boolean;
}

export interface JobContext {
  job: Job;
  params: unknown;
  signal: JobSignal;
  /** 進捗を更新し永続化・通知する。 */
  setProgress(progress: number, total: number): void;
  /**
   * 協調的チェックポイント。cancel されていれば例外、pause 中なら resume まで待つ。
   * ハンドラは各処理単位の境界で await する。
   */
  checkpoint(): Promise<void>;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

export class JobCancelled extends Error {
  constructor() {
    super('job cancelled');
    this.name = 'JobCancelled';
  }
}

interface Controller {
  paused: boolean;
  cancelled: boolean;
  resumeWaiters: (() => void)[];
}

export type ProgressListener = (
  jobId: string,
  kind: JobKind,
  progress: number,
  total: number,
  status: JobStatus,
) => void;

export class JobOrchestrator {
  private handlers = new Map<JobKind, JobHandler>();
  private controllers = new Map<string, Controller>();
  private queue: string[] = [];
  private pumping = false;
  private listeners: ProgressListener[] = [];

  constructor(private readonly store: Store) {}

  register(kind: JobKind, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  onProgress(cb: ProgressListener): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  private emit(job: Job): void {
    for (const l of this.listeners) l(job.id, job.kind, job.progress, job.total, job.status);
  }

  enqueue(kind: JobKind, params: unknown): string {
    const job: Job = {
      id: newId('job'),
      kind,
      status: 'queued',
      progress: 0,
      total: 0,
      resumable: true,
      createdAt: now(),
      updatedAt: now(),
    };
    this.store.createJob(job);
    this.store.setSetting(`job:params:${job.id}`, JSON.stringify(params ?? null));
    this.controllers.set(job.id, { paused: false, cancelled: false, resumeWaiters: [] });
    this.queue.push(job.id);
    void this.pump();
    return job.id;
  }

  pause(id: string): void {
    const job = this.store.getJob(id);
    if (!job || (job.status !== 'running' && job.status !== 'queued')) return;
    const c = this.controllers.get(id);
    if (c) c.paused = true;
    this.patch(id, { status: 'paused' });
  }

  resume(id: string): void {
    const job = this.store.getJob(id);
    if (job && job.status !== 'paused') return;
    const c = this.controllers.get(id);
    if (!c) {
      // プロセス再起動後などコントローラが無ければキューへ戻す。
      this.controllers.set(id, { paused: false, cancelled: false, resumeWaiters: [] });
      if (!this.queue.includes(id)) this.queue.push(id);
      void this.pump();
      return;
    }
    c.paused = false;
    const waiters = c.resumeWaiters.splice(0);
    for (const w of waiters) w();
    this.patch(id, { status: 'running' });
  }

  cancel(id: string): void {
    const job = this.store.getJob(id);
    if (job && (job.status === 'done' || job.status === 'failed')) return;
    const c = this.controllers.get(id);
    if (c) {
      c.cancelled = true;
      c.paused = false;
      const waiters = c.resumeWaiters.splice(0);
      for (const w of waiters) w();
    }
    this.patch(id, { status: 'failed', error: 'cancelled' });
  }

  /** 起動時: 中断された（running/queued/paused）ジョブを再投入して続行。 */
  async recoverOnStartup(): Promise<void> {
    const interrupted = [
      ...this.store.listJobsByStatus('running'),
      ...this.store.listJobsByStatus('queued'),
      ...this.store.listJobsByStatus('paused'),
    ];
    for (const job of interrupted) {
      this.controllers.set(job.id, { paused: false, cancelled: false, resumeWaiters: [] });
      if (!this.queue.includes(job.id)) this.queue.push(job.id);
    }
    await this.pump();
  }

  private patch(id: string, patch: Partial<Omit<Job, 'id'>>): void {
    this.store.updateJob(id, { ...patch, updatedAt: now() });
    const job = this.store.getJob(id);
    if (job) this.emit(job);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift()!;
        // eslint-disable-next-line no-await-in-loop
        await this.runJob(id);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async runJob(id: string): Promise<void> {
    const job = this.store.getJob(id);
    if (!job) return;
    const handler = this.handlers.get(job.kind);
    const controller = this.controllers.get(id);
    if (!handler || !controller) {
      this.patch(id, { status: 'failed', error: 'no handler/controller' });
      return;
    }
    if (controller.cancelled) return;

    this.patch(id, { status: 'running' });
    const paramsRaw = this.store.getSetting(`job:params:${id}`);
    const params = paramsRaw ? JSON.parse(paramsRaw) : null;

    const ctx: JobContext = {
      job: this.store.getJob(id)!,
      params,
      signal: {
        paused: () => controller.paused,
        cancelled: () => controller.cancelled,
      },
      setProgress: (progress, total) => {
        this.patch(id, { progress, total, status: 'running' });
      },
      checkpoint: async () => {
        if (controller.cancelled) throw new JobCancelled();
        while (controller.paused && !controller.cancelled) {
          this.patch(id, { status: 'paused' });
          // eslint-disable-next-line no-await-in-loop
          await new Promise<void>((res) => controller.resumeWaiters.push(res));
        }
        if (controller.cancelled) throw new JobCancelled();
      },
    };

    try {
      await handler(ctx);
      const cur = this.store.getJob(id)!;
      this.patch(id, { status: 'done', progress: cur.total || cur.progress });
    } catch (err) {
      if (err instanceof JobCancelled) {
        this.patch(id, { status: 'failed', error: 'cancelled' });
      } else {
        this.patch(id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}
