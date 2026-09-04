// ============================================================================
// 型付き IPC コントラクト (renderer <-> main <-> core)
// P1 §3: renderer↔core は型付き IPC ラッパ（リクエスト/レスポンス＋進捗イベント）。
//
// - `IpcRequestMap`  … request/response の RPC 群
// - `IpcEventMap`    … core からの一方向 push イベント（進捗など）
// 具体的な処理は core が担い、main は中継のみ。
// ============================================================================

import type {
  Device,
  FolderDiffNode,
  Job,
  JobKind,
  MediaItem,
  NamingRule,
  NamingTemplate,
  OrganizeProposal,
  PairingInfo,
  PersonDTO,
  RestructurePlan,
  RootFolder,
  SpaceReport,
  Story,
  Timeline,
} from './types.js';

// ---- RPC (request -> response) ----

export interface IpcRequestMap {
  // ソース / ルートフォルダ
  'source:addRoot': { req: { path: string }; res: RootFolder };
  'source:listRoots': { req: Record<string, never>; res: RootFolder[] };
  'source:setManagedFlag': { req: { rootId: string; managed: boolean }; res: void };

  // 索引・ジョブ
  'index:start': { req: { rootId: string }; res: { jobId: string } };
  'jobs:list': { req: Record<string, never>; res: Job[] };
  'jobs:pause': { req: { jobId: string }; res: void };
  'jobs:resume': { req: { jobId: string }; res: void };
  'jobs:cancel': { req: { jobId: string }; res: void };

  // メディア一覧（仮想化リスト用のページング）
  'media:list': {
    req: { offset: number; limit: number; rootId?: string };
    res: { items: MediaItem[]; total: number };
  };
  'media:get': { req: { id: string }; res: MediaItem | null };

  // 解析
  'analyze:start': { req: { rootId?: string }; res: { jobId: string } };
  /** 解析結果を全消去して最初から解析し直す（モデル差し替え時など）。原本・索引は保持。 */
  'analyze:reanalyzeAll': { req: Record<string, never>; res: { jobId: string } };

  // 整理エンジン
  'organize:proposeDedup': { req: Record<string, never>; res: OrganizeProposal };
  'organize:proposeJunk': { req: Record<string, never>; res: OrganizeProposal };
  'organize:applyProposal': { req: { proposalId: string }; res: void };
  'organize:proposeRestructure': {
    req: { targetRoot: string; naming: NamingRule };
    res: RestructurePlan;
  };
  'organize:applyRestructure': { req: { planId: string }; res: void };
  'organize:undo': { req: { journalRef: string }; res: void };

  // キュレーション / 演出
  'curation:buildEventStories': { req: Record<string, never>; res: string[] };
  'stories:list': { req: Record<string, never>; res: Story[] };
  'direction:generateTimeline': {
    req: { storyId: string; musicTrackId?: string };
    res: Timeline;
  };
  'direction:getTimeline': { req: { storyId: string }; res: Timeline | null };

  // 設定
  'settings:get': { req: { key: string }; res: string | null };
  'settings:set': { req: { key: string; value: string }; res: void };

  // ===== P2 =====

  // A/M7: サーバー & ペアリング & デバイス
  'server:start': { req: Record<string, never>; res: { running: boolean; info?: PairingInfo } };
  'server:stop': { req: Record<string, never>; res: void };
  'server:status': { req: Record<string, never>; res: { running: boolean; url?: string } };
  'server:generatePin': { req: Record<string, never>; res: PairingInfo };
  'devices:list': { req: Record<string, never>; res: Device[] };
  'devices:revoke': { req: { deviceId: string }; res: void };

  // A/M8: 動画プロキシ生成
  'media:startVideoProxy': { req: Record<string, never>; res: { jobId: string } };

  // B/M10: 人物
  'persons:list': { req: Record<string, never>; res: PersonDTO[] };
  'persons:listUnnamed': { req: Record<string, never>; res: PersonDTO[] };
  'persons:rename': { req: { personId: string; name: string }; res: void };
  'persons:setCover': { req: { personId: string; faceId: string }; res: void };
  'persons:toggleFavorite': { req: { personId: string }; res: void };
  'persons:confirmFace': { req: { faceId: string; personId: string }; res: void };
  'persons:rejectFace': { req: { faceId: string; personId: string }; res: void };
  'persons:merge': { req: { fromId: string; intoId: string }; res: void };
  'persons:recluster': { req: Record<string, never>; res: void };
  'curation:buildPersonStories': { req: Record<string, never>; res: string[] };

  // C/M11: 高度な再配置
  'source:setTemplate': { req: { rootId: string; template: NamingTemplate }; res: void };
  'source:getTemplate': { req: { rootId: string }; res: NamingTemplate | null };
  'organize:proposeRestructureTemplate': {
    req: { targetRoot: string; template: NamingTemplate };
    res: RestructurePlan;
  };
  'organize:proposeArchive': { req: { year: string; targetRoot: string }; res: RestructurePlan };
  'organize:folderDiff': { req: { planId: string }; res: FolderDiffNode };

  // C/M12: 空き容量最適化
  'organize:spaceReport': { req: Record<string, never>; res: SpaceReport };
}

export type IpcChannel = keyof IpcRequestMap;
export type IpcRequest<C extends IpcChannel> = IpcRequestMap[C]['req'];
export type IpcResponse<C extends IpcChannel> = IpcRequestMap[C]['res'];

// ---- core -> renderer push イベント ----

export interface JobProgressEvent {
  jobId: string;
  kind: JobKind;
  progress: number;
  total: number;
  status: Job['status'];
}

export interface IpcEventMap {
  'job:progress': JobProgressEvent;
  'index:updated': { rootId: string; added: number; updated: number };
  'log': { level: 'info' | 'warn' | 'error'; message: string };
}

export type IpcEventName = keyof IpcEventMap;

// ---- 低レベルのワイヤ表現（main <-> core 間 utilityProcess メッセージ） ----

export interface IpcRpcRequestMessage {
  type: 'rpc-request';
  id: number;
  channel: IpcChannel;
  payload: unknown;
}

export interface IpcRpcResponseMessage {
  type: 'rpc-response';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface IpcPushMessage {
  type: 'event';
  event: IpcEventName;
  payload: unknown;
}

export type CoreOutboundMessage = IpcRpcResponseMessage | IpcPushMessage;
export type CoreInboundMessage = IpcRpcRequestMessage;

// renderer の window に露出する preload ブリッジの型
export interface RendererBridge {
  invoke<C extends IpcChannel>(channel: C, payload: IpcRequest<C>): Promise<IpcResponse<C>>;
  on<E extends IpcEventName>(event: E, cb: (payload: IpcEventMap[E]) => void): () => void;
}
