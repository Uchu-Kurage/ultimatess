// ============================================================================
// CoreApp — ヘッドレスコアの中枢 (設計書 v3 §4 / §5)。
// Store・各エンジン・ジョブ基盤を組み立て、型付き IPC を捌く。
// utilityProcess(entry.ts) から呼ばれるが、テストからも直接生成できる。
// ============================================================================

import * as os from 'node:os';
import type { IpcChannel, IpcEventMap, IpcRequest, IpcResponse } from '../shared/ipc.js';
import type { Job, NamingTemplate } from '../shared/types.js';
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
import { FfmpegProxyGenerator, VideoProxyBatch, type VideoProxyGenerator } from './media/videoProxy.js';
import { OrganizeEngine } from './organize/organizeEngine.js';
import { PersonEngine } from './persons/personEngine.js';
import { MediaServer } from './server/mediaServer.js';
import { PairingManager } from './server/pairing.js';
import { LocalFolderProvider, looksManagedByOtherApp } from './source/sourceProvider.js';
import type { SourceProvider } from './source/sourceProvider.js';
import type { Store } from './store/store.js';

export interface CoreDeps {
  store: Store;
  fileop: FileOpAdapter;
  provider?: SourceProvider;
  ml?: MLAdapter;
  probe: MediaProbe;
  /** 派生キャッシュのルート（配信・プロキシ出力先）。 */
  cacheDir?: string;
  musicDir?: string;
  /** ローカルサーバーのポート（既定 8787）。 */
  serverPort?: number;
  /** テスト用に差し替え可能な動画プロキシ生成器。 */
  proxyGenerator?: VideoProxyGenerator;
  /** スマホ Web クライアント HTML のパス。 */
  mobileIndexPath?: string;
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
  private persons: PersonEngine;
  private pairing: PairingManager;
  private proxyGenerator: VideoProxyGenerator;
  private cacheDir: string;
  private musicDir?: string;
  private serverPort: number;
  private mobileIndexPath?: string;
  private server: MediaServer | null = null;
  private serverUrl?: string;
  private emit: EventEmit = () => {};

  constructor(deps: CoreDeps) {
    this.store = deps.store;
    this.provider = deps.provider ?? new LocalFolderProvider();
    this.probe = deps.probe;
    const ml = deps.ml ?? new MockMLAdapter();
    this.cacheDir = deps.cacheDir ?? '.appdata/cache';
    this.musicDir = deps.musicDir;
    this.serverPort = deps.serverPort ?? 8787;
    this.mobileIndexPath = deps.mobileIndexPath;
    this.proxyGenerator = deps.proxyGenerator ?? new FfmpegProxyGenerator();

    this.orchestrator = new JobOrchestrator(this.store);
    this.indexer = new Indexer(this.store, this.provider, this.probe, (rootId, added, updated) =>
      this.emit('index:updated', { rootId, added, updated }),
    );
    this.analyzer = new Analyzer(this.store, this.provider, ml);
    this.organize = new OrganizeEngine(this.store, deps.fileop);
    this.curation = new CurationEngine(this.store);
    this.direction = new DirectionEngine(this.store);
    this.persons = new PersonEngine(this.store);
    this.pairing = new PairingManager(this.store);

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
      // 解析後、クラスタに対応する人物行を用意する(P2-B)。
      this.persons.syncPersonsFromClusters();
    });
    this.orchestrator.register('restructure', async (ctx) => {
      const { planId } = ctx.params as { planId: string };
      await this.organize.applyRestructure(planId, (d, t) => ctx.setProgress(d, t));
    });
    this.orchestrator.register('proxy', async (ctx) => {
      const batch = new VideoProxyBatch(this.store, this.proxyGenerator, this.cacheDir);
      await batch.run(ctx);
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
      case 'analyze:reanalyzeAll': {
        // 解析結果(顔/埋め込み/クラスタ/人物/訂正)を破棄し、全メディアを再解析。
        this.store.resetAnalysis();
        const jobId = this.orchestrator.enqueue('analyze', {});
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

      // ===== P2: サーバー & ペアリング =====
      case 'server:start':
        return (await this.startServer()) as IpcResponse<C>;
      case 'server:stop':
        await this.stopServer();
        return undefined as IpcResponse<C>;
      case 'server:status':
        return {
          running: this.server != null,
          ...(this.serverUrl ? { url: this.serverUrl } : {}),
        } as IpcResponse<C>;
      case 'server:generatePin': {
        const pin = this.pairing.generatePin();
        return {
          url: this.serverUrl ?? this.lanUrl(this.serverPort),
          pin: pin.pin,
          expiresAt: pin.expiresAt,
        } as IpcResponse<C>;
      }
      case 'devices:list':
        return this.pairing.listDevices() as IpcResponse<C>;
      case 'devices:revoke':
        this.pairing.revoke(p.deviceId);
        return undefined as IpcResponse<C>;

      // ===== P2: 動画プロキシ =====
      case 'media:startVideoProxy': {
        const jobId = this.orchestrator.enqueue('proxy', {});
        return { jobId } as IpcResponse<C>;
      }

      // ===== P2: 人物 =====
      case 'persons:list':
        return this.persons.listPersons() as IpcResponse<C>;
      case 'persons:listUnnamed':
        return this.persons.listUnnamed() as IpcResponse<C>;
      case 'persons:rename':
        this.persons.rename(p.personId, p.name);
        return undefined as IpcResponse<C>;
      case 'persons:setCover':
        this.persons.setCover(p.personId, p.faceId);
        return undefined as IpcResponse<C>;
      case 'persons:toggleFavorite':
        this.persons.toggleFavorite(p.personId);
        return undefined as IpcResponse<C>;
      case 'persons:confirmFace':
        this.persons.confirmFace(p.faceId, p.personId);
        return undefined as IpcResponse<C>;
      case 'persons:rejectFace':
        this.persons.rejectFace(p.faceId, p.personId);
        return undefined as IpcResponse<C>;
      case 'persons:merge':
        this.persons.mergePersons(p.fromId, p.intoId);
        return undefined as IpcResponse<C>;
      case 'persons:recluster':
        this.persons.recluster();
        return undefined as IpcResponse<C>;
      case 'curation:buildPersonStories':
        return (await this.curation.buildPersonStories()) as IpcResponse<C>;

      // ===== P2: 高度な再配置 =====
      case 'source:setTemplate':
        this.store.setRootTemplate(p.rootId, JSON.stringify(p.template));
        return undefined as IpcResponse<C>;
      case 'source:getTemplate': {
        const raw = this.store.getRootTemplate(p.rootId);
        return (raw ? (JSON.parse(raw) as NamingTemplate) : null) as IpcResponse<C>;
      }
      case 'organize:proposeRestructureTemplate':
        return (await this.organize.proposeRestructureTemplate(
          p.targetRoot,
          p.template,
        )) as IpcResponse<C>;
      case 'organize:proposeArchive':
        return (await this.organize.proposeArchive(p.year, p.targetRoot)) as IpcResponse<C>;
      case 'organize:folderDiff':
        return this.organize.folderDiffByPlanId(p.planId) as IpcResponse<C>;

      // ===== P2: 空き容量 =====
      case 'organize:spaceReport':
        return (await this.organize.spaceReport()) as IpcResponse<C>;

      default:
        throw new Error(`未対応の IPC チャネル: ${channel}`);
    }
  }

  // --------------------------------------------------------------------------
  // ローカルサーバー(§A) — LAN のみ。書き込み系 API は公開しない。
  // --------------------------------------------------------------------------
  private async startServer(): Promise<{ running: boolean; info?: { url: string; pin: string; expiresAt: number } }> {
    if (!this.server) {
      this.server = new MediaServer({
        store: this.store,
        cacheDir: this.cacheDir,
        ...(this.musicDir ? { musicDir: this.musicDir } : {}),
        ...(this.mobileIndexPath ? { mobileIndexPath: this.mobileIndexPath } : {}),
      });
    }
    // LAN インターフェースのみにバインドする(§A-2)。全インターフェース(0.0.0.0)には
    // 公開しない。LAN IPv4 が見つからない隔離環境ではループバックに退避する。
    const host = this.lanHost();
    const { port } = await this.server.listen(this.serverPort, host);
    this.serverUrl = `http://${host}:${port}`;
    const pin = this.pairing.generatePin();
    return { running: true, info: { url: this.serverUrl, pin: pin.pin, expiresAt: pin.expiresAt } };
  }

  /** バインド対象の LAN IPv4（無ければ 127.0.0.1）。 */
  private lanHost(): string {
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
      for (const ni of list ?? []) {
        if (ni.family === 'IPv4' && !ni.internal) return ni.address;
      }
    }
    return '127.0.0.1';
  }

  private async stopServer(): Promise<void> {
    if (this.server) {
      await this.server.close();
      this.server = null;
      this.serverUrl = undefined;
    }
  }

  /** LAN 上の到達 URL（バインドと同じ LAN IPv4 を用いる）。 */
  private lanUrl(port: number): string {
    return `http://${this.lanHost()}:${port}`;
  }

  listJobsSnapshot(): Job[] {
    return this.store.listJobs();
  }
}
