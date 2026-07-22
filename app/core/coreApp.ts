// ============================================================================
// CoreApp — ヘッドレスコアの中枢 (設計書 v3 §4 / §5)。
// Store・各エンジン・ジョブ基盤を組み立て、型付き IPC を捌く。
// utilityProcess(entry.ts) から呼ばれるが、テストからも直接生成できる。
// ============================================================================

import type { IpcChannel, IpcEventMap, IpcRequest, IpcResponse } from '../shared/ipc.js';
import type { Job } from '../shared/types.js';
import { newId } from '../shared/util.js';
import { Analyzer } from './analysis/analyzer.js';
import { MockMLAdapter } from './analysis/mlAdapter.js';
import type { MLAdapter } from './analysis/mlAdapter.js';
import { CurationEngine } from './curation/curationEngine.js';
import { DirectionEngine } from './direction/directionEngine.js';
import type { FileOpAdapter } from './fileop/fileOpAdapter.js';
import { Indexer } from './index/indexer.js';
import type { MediaProbe } from './index/mediaProbe.js';
import { JobOrchestrator } from './jobs/jobOrchestrator.js';
import { OrganizeEngine } from './organize/organizeEngine.js';
import { LocalFolderProvider, looksManagedByOtherApp } from './source/sourceProvider.js';
import type { SourceProvider } from './source/sourceProvider.js';
import type { Store } from './store/store.js';

export interface CoreDeps {
  store: Store;
  fileop: FileOpAdapter;
  provider?: SourceProvider;
  ml?: MLAdapter;
  probe: MediaProbe;
}

export type EventEmit = <E extends keyof IpcEventMap>(event: E, payload: IpcEventMap[E]) => void;

export class CoreApp {
  private store: Store;
  private provider: SourceProvider;
  private probe: MediaProbe;
  private orchestrator: JobOrchestrator;
  private indexer: Indexer;
  private analyzer: Analyzer;
  private organize: OrganizeEngine;
  private curation: CurationEngine;
  private direction: DirectionEngine;
  private emit: EventEmit = () => {};

  constructor(deps: CoreDeps) {
    this.store = deps.store;
    this.provider = deps.provider ?? new LocalFolderProvider();
    this.probe = deps.probe;
    const ml = deps.ml ?? new MockMLAdapter();

    this.orchestrator = new JobOrchestrator(this.store);
    this.indexer = new Indexer(this.store, this.provider, this.probe, (rootId, added, updated) =>
      this.emit('index:updated', { rootId, added, updated }),
    );
    this.analyzer = new Analyzer(this.store, this.provider, ml);
    this.organize = new OrganizeEngine(this.store, deps.fileop);
    this.curation = new CurationEngine(this.store);
    this.direction = new DirectionEngine(this.store);

    this.registerJobHandlers();
    this.orchestrator.onProgress((jobId, kind, progress, total, status) =>
      this.emit('job:progress', { jobId, kind, progress, total, status }),
    );
  }

  setEmitter(emit: EventEmit): void {
    this.emit = emit;
  }

  /** 起動時の再開/巻き戻し(§7.3, §5.9)。 */
  async recoverOnStartup(): Promise<void> {
    await this.organize.recoverOnStartup();
    await this.orchestrator.recoverOnStartup();
  }

  private registerJobHandlers(): void {
    this.orchestrator.register('index', async (ctx) => {
      const { rootId } = ctx.params as { rootId: string };
      await this.indexer.indexRoot(rootId, ctx);
      // 索引直後に解析を自動投入する。
      this.orchestrator.enqueue('analyze', { rootId });
    });
    this.orchestrator.register('analyze', async (ctx) => {
      await this.analyzer.analyzeAll(ctx);
    });
    this.orchestrator.register('restructure', async (ctx) => {
      const { planId } = ctx.params as { planId: string };
      await this.organize.applyRestructure(planId, (d, t) => ctx.setProgress(d, t));
    });
  }

  // --------------------------------------------------------------------------
  // 型付き IPC ディスパッチ
  // --------------------------------------------------------------------------
  async handle<C extends IpcChannel>(channel: C, payload: IpcRequest<C>): Promise<IpcResponse<C>> {
    // 実装は any 経由でルーティングし、境界の型は IpcRequestMap が保証する。
    const p = payload as any;
    switch (channel) {
      case 'source:addRoot': {
        const root = {
          id: newId('root'),
          path: p.path as string,
          isOnline: true,
          managedByOtherApp: looksManagedByOtherApp(p.path),
        };
        this.store.addRoot(root);
        return root as IpcResponse<C>;
      }
      case 'source:listRoots':
        return this.store.listRoots() as IpcResponse<C>;
      case 'source:setManagedFlag':
        this.store.setRootManaged(p.rootId, p.managed);
        return undefined as IpcResponse<C>;

      case 'index:start': {
        const jobId = this.orchestrator.enqueue('index', { rootId: p.rootId });
        return { jobId } as IpcResponse<C>;
      }
      case 'jobs:list':
        return this.store.listJobs() as IpcResponse<C>;
      case 'jobs:pause':
        this.orchestrator.pause(p.jobId);
        return undefined as IpcResponse<C>;
      case 'jobs:resume':
        this.orchestrator.resume(p.jobId);
        return undefined as IpcResponse<C>;
      case 'jobs:cancel':
        this.orchestrator.cancel(p.jobId);
        return undefined as IpcResponse<C>;

      case 'media:list': {
        const items = this.store.listMedia(p.offset, p.limit, p.rootId);
        const total = this.store.countMedia(p.rootId);
        return { items, total } as IpcResponse<C>;
      }
      case 'media:get':
        return this.store.getMedia(p.id) as IpcResponse<C>;

      case 'analyze:start': {
        const jobId = this.orchestrator.enqueue('analyze', { rootId: p.rootId });
        return { jobId } as IpcResponse<C>;
      }

      case 'organize:proposeDedup':
        return (await this.organize.proposeDedup()) as IpcResponse<C>;
      case 'organize:proposeJunk':
        return (await this.organize.proposeJunk()) as IpcResponse<C>;
      case 'organize:applyProposal':
        await this.organize.applyProposal(p.proposalId);
        return undefined as IpcResponse<C>;
      case 'organize:proposeRestructure':
        return (await this.organize.proposeRestructure(p.targetRoot, p.naming)) as IpcResponse<C>;
      case 'organize:applyRestructure': {
        // 進捗を出すためジョブとして実行する。
        this.orchestrator.enqueue('restructure', { planId: p.planId });
        return undefined as IpcResponse<C>;
      }
      case 'organize:undo':
        await this.organize.undo(p.journalRef);
        return undefined as IpcResponse<C>;

      case 'curation:buildEventStories':
        return (await this.curation.buildEventStories()) as IpcResponse<C>;
      case 'stories:list':
        return this.store.listStories() as IpcResponse<C>;
      case 'direction:generateTimeline':
        return (await this.direction.generateTimeline(p.storyId, {
          ...(p.musicTrackId ? { musicTrackId: p.musicTrackId } : {}),
        })) as IpcResponse<C>;
      case 'direction:getTimeline':
        return this.store.getTimelineByStory(p.storyId) as IpcResponse<C>;

      case 'settings:get':
        return this.store.getSetting(p.key) as IpcResponse<C>;
      case 'settings:set':
        this.store.setSetting(p.key, p.value);
        return undefined as IpcResponse<C>;

      default:
        throw new Error(`未対応の IPC チャネル: ${channel}`);
    }
  }

  listJobsSnapshot(): Job[] {
    return this.store.listJobs();
  }
}
