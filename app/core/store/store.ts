// ============================================================================
// Store 抽象化。
// - コアの各エンジンは Store インターフェースにのみ依存する。
// - 本番は SqliteStore(better-sqlite3)、テストは InMemoryStore を注入する。
//   これにより §7 の安全な移動パイプライン等をネイティブ依存なしで検証できる。
// ============================================================================

import type {
  AnalysisStatus,
  Device,
  DuplicateGroup,
  Face,
  FaceFeedback,
  Job,
  JobStatus,
  MediaItem,
  MusicTrack,
  OperationJournalEntry,
  Person,
  QualityScore,
  RestructureItemRow,
  RestructureItemState,
  RestructurePlanStatus,
  RootFolder,
  SceneLabel,
  Story,
  StoryItem,
  Timeline,
} from '../../shared/types.js';

export interface RestructurePlanRow {
  id: string;
  jobId?: string;
  status: RestructurePlanStatus;
  targetRoot: string;
  spaceRequired: number;
}

export interface Store {
  // ---- ルートフォルダ ----
  addRoot(root: RootFolder): void;
  getRoot(id: string): RootFolder | null;
  listRoots(): RootFolder[];
  setRootManaged(id: string, managed: boolean): void;
  setRootOnline(id: string, online: boolean): void;

  // ---- メディア ----
  upsertMedia(item: MediaItem): void;
  getMedia(id: string): MediaItem | null;
  getMediaBySourceRef(ref: string): MediaItem | null;
  listMedia(offset: number, limit: number, rootId?: string): MediaItem[];
  countMedia(rootId?: string): number;
  listMediaByStatus(status: AnalysisStatus, limit?: number): MediaItem[];
  allMedia(): MediaItem[];
  updateSourceRef(id: string, newPath: string): void;
  setAnalysisStatus(id: string, status: AnalysisStatus): void;
  /**
   * 解析結果を全消去し、全メディアを再解析対象(pending)に戻す。
   * 原本・索引(media_item)・ルートは保持し、顔/埋め込み/品質/シーン/重複/人物/訂正を破棄する。
   * モデル差し替え時（Mock→実モデル等）にゼロから解析し直すために使う。
   */
  resetAnalysis(): void;

  // ---- 顔 / 人物 ----
  insertFace(face: Face): void;
  listFacesByMedia(mediaId: string): Face[];
  listAllFaces(): Face[];
  setFaceCluster(faceId: string, clusterId: string): void;
  upsertPerson(person: Person): void;
  listPersons(): Person[];

  // ---- 品質 / シーン ----
  upsertQuality(mediaId: string, q: QualityScore): void;
  getQuality(mediaId: string): QualityScore | null;
  insertSceneLabel(label: SceneLabel): void;
  listScenesByMedia(mediaId: string): SceneLabel[];

  // ---- 重複 ----
  replaceDuplicateGroups(groups: DuplicateGroup[]): void;
  listDuplicateGroups(): DuplicateGroup[];

  // ---- ジョブ ----
  createJob(job: Job): void;
  getJob(id: string): Job | null;
  listJobs(): Job[];
  listJobsByStatus(status: JobStatus): Job[];
  updateJob(id: string, patch: Partial<Omit<Job, 'id'>>): void;

  // ---- 物理再配置 ----
  createRestructurePlan(plan: RestructurePlanRow): void;
  getRestructurePlan(id: string): RestructurePlanRow | null;
  updateRestructurePlanStatus(id: string, status: RestructurePlanStatus): void;
  listRestructurePlansByStatus(...statuses: RestructurePlanStatus[]): RestructurePlanRow[];
  insertRestructureItems(items: RestructureItemRow[]): void;
  listRestructureItems(planId: string): RestructureItemRow[];
  listRestructureItemsByState(
    planId: string,
    states: RestructureItemState[],
  ): RestructureItemRow[];
  updateRestructureItem(
    planId: string,
    mediaId: string,
    patch: Partial<Pick<RestructureItemRow, 'state' | 'checksum' | 'error'>>,
  ): void;

  // ---- 操作ジャーナル (Undo) ----
  appendJournal(entry: OperationJournalEntry): void;
  listJournalByRef(refType: string, refId: string): OperationJournalEntry[];
  getJournal(id: string): OperationJournalEntry | null;

  // ---- スライドショー ----
  createStory(story: Story): void;
  listStories(): Story[];
  getStory(id: string): Story | null;
  replaceStoryItems(storyId: string, items: StoryItem[]): void;
  listStoryItems(storyId: string): StoryItem[];
  upsertTimeline(timeline: Timeline): void;
  getTimelineByStory(storyId: string): Timeline | null;
  listMusicTracks(): MusicTrack[];
  insertMusicTrack(track: MusicTrack): void;

  // ---- 設定 ----
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;

  // ========================================================================
  // P2 追加
  // ========================================================================

  // ---- 人物 / 顔フィードバック (M10) ----
  getPerson(id: string): Person | null;
  getPersonByCluster(clusterId: string): Person | null;
  listActivePersons(): Person[];
  setPersonMergedInto(id: string, into: string): void;
  addFaceFeedback(f: FaceFeedback): void;
  listFaceFeedback(): FaceFeedback[];
  listFeedbackForPerson(personId: string): FaceFeedback[];
  addClusterMergeLog(id: string, from: string, into: string, createdAt: number): void;

  // ---- メディア: 動画プロキシ (M8) ----
  setVideoProxyPath(id: string, proxyPath: string): void;
  getVideoProxyPath(id: string): string | null;
  listVideosWithoutProxy(limit?: number): MediaItem[];

  // ---- ルート命名テンプレート (M11) ----
  setRootTemplate(rootId: string, templateJson: string): void;
  getRootTemplate(rootId: string): string | null;

  // ---- デバイス / ペアリング (M7) ----
  addDevice(d: Device): void;
  getDeviceByToken(token: string): Device | null;
  listDevices(): Device[];
  revokeDevice(id: string): void;
  touchDevice(id: string, lastSeen: number): void;

  close(): void;
}
