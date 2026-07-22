// ============================================================================
// Store 抽象化。
// - コアの各エンジンは Store インターフェースにのみ依存する。
// - 本番は SqliteStore(better-sqlite3)、テストは InMemoryStore を注入する。
//   これにより §7 の安全な移動パイプライン等をネイティブ依存なしで検証できる。
// ============================================================================

import type {
  AnalysisStatus,
  DuplicateGroup,
  Face,
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

  close(): void;
}
