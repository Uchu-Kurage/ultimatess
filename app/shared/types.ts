// ============================================================================
// 共有ドメイン型 (main / renderer / core すべてが参照)
// 設計書 v3 §6 データモデル / P1 §6 層別インターフェース に対応。
// ============================================================================

export type MediaType = 'photo' | 'video';

export type AnalysisStatus = 'pending' | 'partial' | 'done' | 'failed';

export interface Gps {
  lat: number;
  lng: number;
}

export interface MediaItem {
  id: string;
  rootId: string;
  /** 原本への参照パス。原本は読み取り専用（整理操作時のみ物理移動）。 */
  sourceRef: string;
  mediaType: MediaType;
  /** 撮影日時(EXIF)。無ければ null。 */
  createdAt: number | null;
  /** EXIF 日時が無くファイル更新日時で代替した場合 true。 */
  dateUncertain: boolean;
  gps?: Gps;
  placeName?: string;
  width: number;
  height: number;
  durationMs?: number;
  orientation: number;
  /** 内容の同一性判定用（完全重複）。 */
  contentHash: string;
  /** 近似重複判定用の知覚ハッシュ（16進文字列）。 */
  perceptualHash: string;
  thumbPath: string;
  previewPath: string;
  analysisStatus: AnalysisStatus;
}

export interface RootFolder {
  id: string;
  path: string;
  driveId?: string;
  isOnline: boolean;
  /** Apple Photos / Lightroom 等の他アプリ管理下。既定で再配置対象外(§2-3)。 */
  managedByOtherApp: boolean;
}

// ---- 解析 ----

/** [x, y, w, h] 正規化 or ピクセル座標（実装で統一）。 */
export type BBox = [number, number, number, number];

export interface FaceDetection {
  bbox: BBox;
  landmarks?: number[];
  quality: number;
  eyesOpen: boolean;
}

export interface Face extends FaceDetection {
  id: string;
  mediaId: string;
  embedding: Float32Array;
  clusterId?: string;
}

export interface Person {
  id: string;
  clusterId: string;
  displayName?: string;
  coverFaceId?: string;
  isFavorite: boolean;
  /** ユーザーが名前を確定済みか（P2-B）。 */
  confirmed?: boolean;
  /** 統合された場合の統合先 person_id（P2-B）。 */
  mergedInto?: string;
  /** clusterId から独立した安定キー（再クラスタで人物同一性を保つ）。 */
  personKey?: string;
}

// ---- P2-B 人物訂正フィードバック ----

export type FeedbackVerdict = 'confirm' | 'reject';

export interface FaceFeedback {
  id: string;
  faceId: string;
  personId: string;
  /** confirm = must-link（この顔はこの人物）/ reject = cannot-link（この人物ではない）。 */
  verdict: FeedbackVerdict;
  createdAt: number;
}

export interface QualityScore {
  sharpness: number;
  exposure: number;
  composition: number;
  eyesOpen: number;
  composite: number;
}

export interface SceneLabel {
  mediaId: string;
  label: string;
  confidence: number;
}

export interface DuplicateGroup {
  id: string;
  createdAt: number;
  members: DuplicateMember[];
}

export interface DuplicateMember {
  groupId: string;
  mediaId: string;
  isRepresentative: boolean;
}

// ---- ジョブ & 物理再配置 ----

export type JobKind = 'index' | 'analyze' | 'dedup' | 'restructure' | 'proxy';
export type JobStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed';

export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  progress: number;
  total: number;
  resumable: boolean;
  createdAt: number;
  updatedAt: number;
  /** 失敗時の理由（あれば）。 */
  error?: string;
}

export type RestructurePlanStatus =
  | 'preview'
  | 'approved'
  | 'running'
  | 'done'
  | 'reverted'
  | 'failed';

/** §7.2 の状態機械。各遷移ごとに即コミットされる（再開点）。 */
export type RestructureItemState =
  | 'pending'
  | 'renamed'
  | 'copied'
  | 'verified'
  | 'source_trashed'
  | 'done'
  | 'failed';

export interface RestructureItemRow {
  planId: string;
  mediaId: string;
  fromPath: string;
  toPath: string;
  sameDrive: boolean;
  checksum?: string;
  state: RestructureItemState;
  error?: string;
}

export interface RestructurePlan {
  id: string;
  jobId?: string;
  status: RestructurePlanStatus;
  targetRoot: string;
  /** ドライブ跨ぎコピーに必要な合計バイト数（空き容量チェック用）。 */
  spaceRequired: number;
  items: RestructurePlanItem[];
  conflicts: RestructureConflict[];
}

export interface RestructurePlanItem {
  mediaId: string;
  fromPath: string;
  toPath: string;
  sameDrive: boolean;
}

export interface RestructureConflict {
  mediaId: string;
  toPath: string;
}

export type JournalOp = 'move' | 'trash' | 'restructure';

export interface OperationJournalEntry {
  id: string;
  refType: string;
  refId: string;
  op: JournalOp;
  fromPath: string;
  toPath: string;
  executedAt: number;
  reversible: boolean;
  undoRef?: string;
}

// ---- 整理提案 ----

export type OrganizeKind = 'dedup' | 'junk';

export interface OrganizeProposalItem {
  mediaId: string;
  action: 'trash' | 'keep';
  /** 提案理由（UI 表示用）。 */
  reason?: string;
}

export interface OrganizeProposal {
  id: string;
  kind: OrganizeKind;
  items: OrganizeProposalItem[];
}

// ---- 命名規則 ----

export interface NamingRule {
  /** 年フォルダを作るか（例: 2024/）。 */
  yearFolder: boolean;
  /** 日付_イベント名 フォルダを作るか。 */
  dateEventFolder: boolean;
  /** ファイル名に日付時刻プレフィックスを付けるか。 */
  dateTimePrefix: boolean;
  /** 元ファイル名を保持するか。 */
  keepOriginalName: boolean;
}

export const DEFAULT_NAMING_RULE: NamingRule = {
  yearFolder: true,
  dateEventFolder: true,
  dateTimePrefix: true,
  keepOriginalName: true,
};

// ---- スライドショー ----

export type StoryKind = 'event' | 'person' | 'period' | 'theme';

export interface Story {
  id: string;
  title: string;
  kind: StoryKind;
  startAt: number | null;
  endAt: number | null;
  placeName?: string;
  coverMediaId?: string;
}

export type StoryItemRole = 'hero' | 'support';

export interface StoryItem {
  storyId: string;
  mediaId: string;
  order: number;
  role: StoryItemRole;
}

/** Ken Burns の始点/終点矩形 [x, y, w, h]（0..1 正規化）。 */
export type Rect = [number, number, number, number];

export type TransitionKind = 'none' | 'crossfade' | 'fade-black' | 'slide';

export interface TimelineClip {
  timelineId: string;
  mediaId: string;
  order: number;
  startMs: number;
  durationMs: number;
  kbStartRect: Rect;
  kbEndRect: Rect;
  transitionIn: TransitionKind;
}

export interface Timeline {
  id: string;
  storyId: string;
  generatedAt: number;
  musicTrackId?: string;
  config: TimelineConfig;
  clips: TimelineClip[];
}

export interface TimelineConfig {
  /** 1 枚あたりの基本表示尺(ms)。 */
  baseDurationMs: number;
  transition: TransitionKind;
  transitionMs: number;
  kenBurns: boolean;
}

export interface MusicTrack {
  id: string;
  source: 'bundled' | 'library';
  title: string;
  path: string;
  bpm?: number;
}

export interface AppSetting {
  key: string;
  value: string;
}

// ============================================================================
// P2 追加型
// ============================================================================

// ---- A/M7 デバイス・ペアリング ----

export interface Device {
  id: string;
  name: string;
  /** 長期トークン（Authorization に使用）。スマホへは発行時のみ返す。 */
  token: string;
  createdAt: number;
  lastSeen: number;
  revoked: boolean;
}

export interface PairingInfo {
  /** LAN 上の到達先 URL（例 http://192.168.1.10:8787）。 */
  url: string;
  /** ペアリング用 PIN（短命）。 */
  pin: string;
  /** PIN 有効期限(ms)。 */
  expiresAt: number;
}

// ---- C/M11 命名テンプレート ----

/**
 * トークン: {yyyy} {MM} {dd} {HHmmss} {event} {place} {person} {original} {seq}
 * 既定: {yyyy}/{yyyy}-{MM}-{dd}_{event}/{yyyy}-{MM}-{dd}_{HHmmss}_{original}
 */
export interface NamingTemplate {
  /** パス区切り '/' を含むテンプレート文字列。 */
  template: string;
  /** {event} 未解決時のフォールバック順。 */
  fallback: ('event' | 'place' | 'date')[];
  /** date_uncertain の写真を隔離するフォルダ名（自動で誤った年に入れない）。 */
  uncertainFolder: string;
  /** 元ファイル名を保持するか（{original} を使うかは template 次第だが保険）。 */
  keepOriginalName: boolean;
}

export const DEFAULT_TEMPLATE: NamingTemplate = {
  template: '{yyyy}/{yyyy}-{MM}-{dd}_{event}/{yyyy}-{MM}-{dd}_{HHmmss}_{original}',
  fallback: ['event', 'place', 'date'],
  uncertainFolder: '_日付未確定',
  keepOriginalName: true,
};

// ---- C/M11 Before/After 差分 ----

export interface FolderDiffNode {
  path: string; // ライブラリルートからの相対
  addedCount: number;
  children: FolderDiffNode[];
}

// ---- C/M12 空き容量最適化 ----

export interface SpaceReport {
  totalBytes: number;
  reclaimable: {
    duplicates: number;
    junk: number;
    videoProxies: number;
  };
  byYear: { year: string; bytes: number; count: number }[];
  largest: { mediaId: string; sourceRef: string; bytes: number; mediaType: MediaType }[];
}

// ---- A/M8 スマホ配信 DTO（原本・埋め込みは送らない） ----

export interface StorySummaryDTO {
  id: string;
  title: string;
  kind: StoryKind;
  startAt: number | null;
  endAt: number | null;
  placeName?: string;
  coverMediaId?: string;
  itemCount: number;
}

export interface PersonDTO {
  id: string;
  displayName?: string;
  coverMediaId?: string;
  isFavorite: boolean;
  photoCount: number;
}
