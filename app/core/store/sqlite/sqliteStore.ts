// ============================================================================
// SqliteStore — Store の本番実装 (better-sqlite3)。
// InMemoryStore と同一の契約を満たす。行 <-> ドメイン型の変換をここで吸収する。
// ============================================================================

import type {
  AnalysisStatus,
  BBox,
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
} from '../../../shared/types.js';
import type { RestructurePlanRow, Store } from '../store.js';
import { openDatabase, type Db } from './db.js';

export class SqliteStore implements Store {
  private db: Db;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  // ---- ルート ----
  addRoot(r: RootFolder): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO root_folder (id, path, drive_id, is_online, managed_by_other_app)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.path, r.driveId ?? null, r.isOnline ? 1 : 0, r.managedByOtherApp ? 1 : 0);
  }
  getRoot(id: string): RootFolder | null {
    const row = this.db.prepare(`SELECT * FROM root_folder WHERE id = ?`).get(id) as any;
    return row ? rowToRoot(row) : null;
  }
  listRoots(): RootFolder[] {
    return (this.db.prepare(`SELECT * FROM root_folder`).all() as any[]).map(rowToRoot);
  }
  setRootManaged(id: string, managed: boolean): void {
    this.db.prepare(`UPDATE root_folder SET managed_by_other_app = ? WHERE id = ?`).run(managed ? 1 : 0, id);
  }
  setRootOnline(id: string, online: boolean): void {
    this.db.prepare(`UPDATE root_folder SET is_online = ? WHERE id = ?`).run(online ? 1 : 0, id);
  }

  // ---- メディア ----
  upsertMedia(m: MediaItem): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO media_item
         (id, root_id, source_ref, media_type, created_at, date_uncertain, gps_lat, gps_lng,
          place_name, width, height, duration_ms, orientation, content_hash, perceptual_hash,
          thumb_path, preview_path, analysis_status)
         VALUES (@id,@root_id,@source_ref,@media_type,@created_at,@date_uncertain,@gps_lat,@gps_lng,
          @place_name,@width,@height,@duration_ms,@orientation,@content_hash,@perceptual_hash,
          @thumb_path,@preview_path,@analysis_status)`,
      )
      .run({
        id: m.id,
        root_id: m.rootId,
        source_ref: m.sourceRef,
        media_type: m.mediaType,
        created_at: m.createdAt,
        date_uncertain: m.dateUncertain ? 1 : 0,
        gps_lat: m.gps?.lat ?? null,
        gps_lng: m.gps?.lng ?? null,
        place_name: m.placeName ?? null,
        width: m.width,
        height: m.height,
        duration_ms: m.durationMs ?? null,
        orientation: m.orientation,
        content_hash: m.contentHash,
        perceptual_hash: m.perceptualHash,
        thumb_path: m.thumbPath,
        preview_path: m.previewPath,
        analysis_status: m.analysisStatus,
      });
  }
  getMedia(id: string): MediaItem | null {
    const row = this.db.prepare(`SELECT * FROM media_item WHERE id = ?`).get(id) as any;
    return row ? rowToMedia(row) : null;
  }
  getMediaBySourceRef(ref: string): MediaItem | null {
    const row = this.db.prepare(`SELECT * FROM media_item WHERE source_ref = ?`).get(ref) as any;
    return row ? rowToMedia(row) : null;
  }
  listMedia(offset: number, limit: number, rootId?: string): MediaItem[] {
    const rows = rootId
      ? this.db
          .prepare(
            `SELECT * FROM media_item WHERE root_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          )
          .all(rootId, limit, offset)
      : this.db
          .prepare(`SELECT * FROM media_item ORDER BY created_at DESC LIMIT ? OFFSET ?`)
          .all(limit, offset);
    return (rows as any[]).map(rowToMedia);
  }
  countMedia(rootId?: string): number {
    const row = rootId
      ? this.db.prepare(`SELECT COUNT(*) n FROM media_item WHERE root_id = ?`).get(rootId)
      : this.db.prepare(`SELECT COUNT(*) n FROM media_item`).get();
    return (row as any).n as number;
  }
  listMediaByStatus(status: AnalysisStatus, limit?: number): MediaItem[] {
    const rows = limit
      ? this.db.prepare(`SELECT * FROM media_item WHERE analysis_status = ? LIMIT ?`).all(status, limit)
      : this.db.prepare(`SELECT * FROM media_item WHERE analysis_status = ?`).all(status);
    return (rows as any[]).map(rowToMedia);
  }
  allMedia(): MediaItem[] {
    return (this.db.prepare(`SELECT * FROM media_item`).all() as any[]).map(rowToMedia);
  }
  updateSourceRef(id: string, newPath: string): void {
    this.db.prepare(`UPDATE media_item SET source_ref = ? WHERE id = ?`).run(newPath, id);
  }
  setAnalysisStatus(id: string, status: AnalysisStatus): void {
    this.db.prepare(`UPDATE media_item SET analysis_status = ? WHERE id = ?`).run(status, id);
  }

  // ---- 顔 / 人物 ----
  insertFace(f: Face): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO face (id, media_id, bbox, embedding, quality, eyes_open, cluster_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        f.id,
        f.mediaId,
        JSON.stringify(f.bbox),
        Buffer.from(f.embedding.buffer, f.embedding.byteOffset, f.embedding.byteLength),
        f.quality,
        f.eyesOpen ? 1 : 0,
        f.clusterId ?? null,
      );
  }
  listFacesByMedia(mediaId: string): Face[] {
    return (this.db.prepare(`SELECT * FROM face WHERE media_id = ?`).all(mediaId) as any[]).map(rowToFace);
  }
  listAllFaces(): Face[] {
    return (this.db.prepare(`SELECT * FROM face`).all() as any[]).map(rowToFace);
  }
  setFaceCluster(faceId: string, clusterId: string): void {
    this.db.prepare(`UPDATE face SET cluster_id = ? WHERE id = ?`).run(clusterId, faceId);
  }
  upsertPerson(p: Person): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO person
         (id, cluster_id, display_name, cover_face_id, is_favorite, confirmed, merged_into, person_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id,
        p.clusterId,
        p.displayName ?? null,
        p.coverFaceId ?? null,
        p.isFavorite ? 1 : 0,
        p.confirmed ? 1 : 0,
        p.mergedInto ?? null,
        p.personKey ?? null,
      );
  }
  listPersons(): Person[] {
    return (this.db.prepare(`SELECT * FROM person`).all() as any[]).map(rowToPerson);
  }

  // ---- 品質 / シーン ----
  upsertQuality(mediaId: string, q: QualityScore): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO quality_score
         (media_id, sharpness, exposure, composition, eyes_open, composite)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(mediaId, q.sharpness, q.exposure, q.composition, q.eyesOpen, q.composite);
  }
  getQuality(mediaId: string): QualityScore | null {
    const r = this.db.prepare(`SELECT * FROM quality_score WHERE media_id = ?`).get(mediaId) as any;
    return r
      ? {
          sharpness: r.sharpness,
          exposure: r.exposure,
          composition: r.composition,
          eyesOpen: r.eyes_open,
          composite: r.composite,
        }
      : null;
  }
  insertSceneLabel(l: SceneLabel): void {
    this.db
      .prepare(`INSERT INTO scene_label (media_id, label, confidence) VALUES (?, ?, ?)`)
      .run(l.mediaId, l.label, l.confidence);
  }
  listScenesByMedia(mediaId: string): SceneLabel[] {
    return (this.db.prepare(`SELECT * FROM scene_label WHERE media_id = ?`).all(mediaId) as any[]).map(
      (r) => ({ mediaId: r.media_id, label: r.label, confidence: r.confidence }),
    );
  }

  // ---- 重複 ----
  replaceDuplicateGroups(groups: DuplicateGroup[]): void {
    const tx = this.db.transaction(() => {
      this.db.exec(`DELETE FROM duplicate_member; DELETE FROM duplicate_group;`);
      const g = this.db.prepare(`INSERT INTO duplicate_group (id, created_at) VALUES (?, ?)`);
      const m = this.db.prepare(
        `INSERT INTO duplicate_member (group_id, media_id, is_representative) VALUES (?, ?, ?)`,
      );
      for (const grp of groups) {
        g.run(grp.id, grp.createdAt);
        for (const mem of grp.members) m.run(grp.id, mem.mediaId, mem.isRepresentative ? 1 : 0);
      }
    });
    tx();
  }
  listDuplicateGroups(): DuplicateGroup[] {
    const groups = this.db.prepare(`SELECT * FROM duplicate_group`).all() as any[];
    return groups.map((g) => {
      const members = this.db
        .prepare(`SELECT * FROM duplicate_member WHERE group_id = ?`)
        .all(g.id) as any[];
      return {
        id: g.id,
        createdAt: g.created_at,
        members: members.map((m) => ({
          groupId: m.group_id,
          mediaId: m.media_id,
          isRepresentative: !!m.is_representative,
        })),
      };
    });
  }

  // ---- ジョブ ----
  createJob(j: Job): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO job (id, kind, status, progress, total, resumable, created_at, updated_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(j.id, j.kind, j.status, j.progress, j.total, j.resumable ? 1 : 0, j.createdAt, j.updatedAt, j.error ?? null);
  }
  getJob(id: string): Job | null {
    const r = this.db.prepare(`SELECT * FROM job WHERE id = ?`).get(id) as any;
    return r ? rowToJob(r) : null;
  }
  listJobs(): Job[] {
    return (this.db.prepare(`SELECT * FROM job ORDER BY created_at DESC`).all() as any[]).map(rowToJob);
  }
  listJobsByStatus(status: JobStatus): Job[] {
    return (this.db.prepare(`SELECT * FROM job WHERE status = ?`).all(status) as any[]).map(rowToJob);
  }
  updateJob(id: string, patch: Partial<Omit<Job, 'id'>>): void {
    const cur = this.getJob(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    this.createJob(next);
  }

  // ---- 物理再配置 ----
  createRestructurePlan(p: RestructurePlanRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO restructure_plan (id, job_id, status, target_root, space_required)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.jobId ?? null, p.status, p.targetRoot, p.spaceRequired);
  }
  getRestructurePlan(id: string): RestructurePlanRow | null {
    const r = this.db.prepare(`SELECT * FROM restructure_plan WHERE id = ?`).get(id) as any;
    return r
      ? { id: r.id, jobId: r.job_id ?? undefined, status: r.status, targetRoot: r.target_root, spaceRequired: r.space_required }
      : null;
  }
  updateRestructurePlanStatus(id: string, status: RestructurePlanStatus): void {
    this.db.prepare(`UPDATE restructure_plan SET status = ? WHERE id = ?`).run(status, id);
  }
  listRestructurePlansByStatus(...statuses: RestructurePlanStatus[]): RestructurePlanRow[] {
    if (statuses.length === 0) return [];
    const ph = statuses.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM restructure_plan WHERE status IN (${ph})`).all(...statuses) as any[];
    return rows.map((r) => ({
      id: r.id,
      jobId: r.job_id ?? undefined,
      status: r.status,
      targetRoot: r.target_root,
      spaceRequired: r.space_required,
    }));
  }
  insertRestructureItems(items: RestructureItemRow[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO restructure_item (plan_id, media_id, from_path, to_path, same_drive, checksum, state, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((rows: RestructureItemRow[]) => {
      for (const it of rows)
        stmt.run(it.planId, it.mediaId, it.fromPath, it.toPath, it.sameDrive ? 1 : 0, it.checksum ?? null, it.state, it.error ?? null);
    });
    tx(items);
  }
  listRestructureItems(planId: string): RestructureItemRow[] {
    return (this.db.prepare(`SELECT * FROM restructure_item WHERE plan_id = ?`).all(planId) as any[]).map(rowToItem);
  }
  listRestructureItemsByState(planId: string, states: RestructureItemState[]): RestructureItemRow[] {
    if (states.length === 0) return [];
    const ph = states.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM restructure_item WHERE plan_id = ? AND state IN (${ph})`)
      .all(planId, ...states) as any[];
    return rows.map(rowToItem);
  }
  updateRestructureItem(
    planId: string,
    mediaId: string,
    patch: Partial<Pick<RestructureItemRow, 'state' | 'checksum' | 'error'>>,
  ): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.state !== undefined) {
      sets.push('state = ?');
      vals.push(patch.state);
    }
    if (patch.checksum !== undefined) {
      sets.push('checksum = ?');
      vals.push(patch.checksum);
    }
    if (patch.error !== undefined) {
      sets.push('error = ?');
      vals.push(patch.error);
    }
    if (sets.length === 0) return;
    vals.push(planId, mediaId);
    this.db.prepare(`UPDATE restructure_item SET ${sets.join(', ')} WHERE plan_id = ? AND media_id = ?`).run(...vals);
  }

  // ---- ジャーナル ----
  appendJournal(e: OperationJournalEntry): void {
    this.db
      .prepare(
        `INSERT INTO operation_journal (id, ref_type, ref_id, op, from_path, to_path, executed_at, reversible, undo_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.id, e.refType, e.refId, e.op, e.fromPath, e.toPath, e.executedAt, e.reversible ? 1 : 0, e.undoRef ?? null);
  }
  listJournalByRef(refType: string, refId: string): OperationJournalEntry[] {
    return (
      this.db
        .prepare(`SELECT * FROM operation_journal WHERE ref_type = ? AND ref_id = ? ORDER BY executed_at ASC`)
        .all(refType, refId) as any[]
    ).map(rowToJournal);
  }
  getJournal(id: string): OperationJournalEntry | null {
    const r = this.db.prepare(`SELECT * FROM operation_journal WHERE id = ?`).get(id) as any;
    return r ? rowToJournal(r) : null;
  }

  // ---- スライドショー ----
  createStory(s: Story): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO story (id, title, kind, start_at, end_at, place_name, cover_media_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.title, s.kind, s.startAt, s.endAt, s.placeName ?? null, s.coverMediaId ?? null);
  }
  listStories(): Story[] {
    return (this.db.prepare(`SELECT * FROM story ORDER BY start_at DESC`).all() as any[]).map(rowToStory);
  }
  getStory(id: string): Story | null {
    const r = this.db.prepare(`SELECT * FROM story WHERE id = ?`).get(id) as any;
    return r ? rowToStory(r) : null;
  }
  deleteStoriesByKind(kind: Story['kind']): void {
    const tx = this.db.transaction(() => {
      const ids = (
        this.db.prepare(`SELECT id FROM story WHERE kind = ?`).all(kind) as { id: string }[]
      ).map((r) => r.id);
      for (const id of ids) {
        const timelineIds = (
          this.db.prepare(`SELECT id FROM timeline WHERE story_id = ?`).all(id) as { id: string }[]
        ).map((t) => t.id);
        for (const tid of timelineIds) {
          this.db.prepare(`DELETE FROM timeline_clip WHERE timeline_id = ?`).run(tid);
        }
        this.db.prepare(`DELETE FROM timeline WHERE story_id = ?`).run(id);
        this.db.prepare(`DELETE FROM story_item WHERE story_id = ?`).run(id);
        this.db.prepare(`DELETE FROM story WHERE id = ?`).run(id);
      }
    });
    tx();
  }
  replaceStoryItems(storyId: string, items: StoryItem[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM story_item WHERE story_id = ?`).run(storyId);
      const stmt = this.db.prepare(
        `INSERT INTO story_item (story_id, media_id, ord, role) VALUES (?, ?, ?, ?)`,
      );
      for (const it of items) stmt.run(it.storyId, it.mediaId, it.order, it.role);
    });
    tx();
  }
  listStoryItems(storyId: string): StoryItem[] {
    return (
      this.db.prepare(`SELECT * FROM story_item WHERE story_id = ? ORDER BY ord ASC`).all(storyId) as any[]
    ).map((r) => ({ storyId: r.story_id, mediaId: r.media_id, order: r.ord, role: r.role }));
  }
  upsertTimeline(t: Timeline): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM timeline WHERE story_id = ?`).run(t.storyId);
      this.db.prepare(`DELETE FROM timeline_clip WHERE timeline_id = ?`).run(t.id);
      this.db
        .prepare(
          `INSERT INTO timeline (id, story_id, generated_at, music_track_id, config) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(t.id, t.storyId, t.generatedAt, t.musicTrackId ?? null, JSON.stringify(t.config));
      const stmt = this.db.prepare(
        `INSERT INTO timeline_clip (timeline_id, media_id, ord, start_ms, duration_ms, kb_start_rect, kb_end_rect, transition_in)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const c of t.clips)
        stmt.run(
          c.timelineId,
          c.mediaId,
          c.order,
          c.startMs,
          c.durationMs,
          JSON.stringify(c.kbStartRect),
          JSON.stringify(c.kbEndRect),
          c.transitionIn,
        );
    });
    tx();
  }
  getTimelineByStory(storyId: string): Timeline | null {
    const t = this.db.prepare(`SELECT * FROM timeline WHERE story_id = ?`).get(storyId) as any;
    if (!t) return null;
    const clips = this.db
      .prepare(`SELECT * FROM timeline_clip WHERE timeline_id = ? ORDER BY ord ASC`)
      .all(t.id) as any[];
    return {
      id: t.id,
      storyId: t.story_id,
      generatedAt: t.generated_at,
      musicTrackId: t.music_track_id ?? undefined,
      config: JSON.parse(t.config),
      clips: clips.map((c) => ({
        timelineId: c.timeline_id,
        mediaId: c.media_id,
        order: c.ord,
        startMs: c.start_ms,
        durationMs: c.duration_ms,
        kbStartRect: JSON.parse(c.kb_start_rect),
        kbEndRect: JSON.parse(c.kb_end_rect),
        transitionIn: c.transition_in,
      })),
    };
  }
  listMusicTracks(): MusicTrack[] {
    return (this.db.prepare(`SELECT * FROM music_track`).all() as any[]).map((r) => ({
      id: r.id,
      source: r.source,
      title: r.title,
      path: r.path,
      bpm: r.bpm ?? undefined,
    }));
  }
  insertMusicTrack(t: MusicTrack): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO music_track (id, source, title, path, bpm) VALUES (?, ?, ?, ?, ?)`)
      .run(t.id, t.source, t.title, t.path, t.bpm ?? null);
  }

  // ---- 設定 ----
  getSetting(key: string): string | null {
    const r = this.db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as any;
    return r ? (r.value as string) : null;
  }
  setSetting(key: string, value: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`).run(key, value);
  }

  // ---- P2: 人物 / フィードバック ----
  getPerson(id: string): Person | null {
    const r = this.db.prepare(`SELECT * FROM person WHERE id = ?`).get(id) as any;
    return r ? rowToPerson(r) : null;
  }
  getPersonByCluster(clusterId: string): Person | null {
    const r = this.db.prepare(`SELECT * FROM person WHERE cluster_id = ? LIMIT 1`).get(clusterId) as any;
    return r ? rowToPerson(r) : null;
  }
  listActivePersons(): Person[] {
    return (this.db.prepare(`SELECT * FROM person WHERE merged_into IS NULL`).all() as any[]).map(rowToPerson);
  }
  setPersonMergedInto(id: string, into: string): void {
    this.db.prepare(`UPDATE person SET merged_into = ? WHERE id = ?`).run(into, id);
  }
  addFaceFeedback(f: FaceFeedback): void {
    this.db
      .prepare(`INSERT INTO face_feedback (id, face_id, person_id, verdict, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(f.id, f.faceId, f.personId, f.verdict, f.createdAt);
  }
  listFaceFeedback(): FaceFeedback[] {
    return (this.db.prepare(`SELECT * FROM face_feedback`).all() as any[]).map(rowToFeedback);
  }
  listFeedbackForPerson(personId: string): FaceFeedback[] {
    return (this.db.prepare(`SELECT * FROM face_feedback WHERE person_id = ?`).all(personId) as any[]).map(
      rowToFeedback,
    );
  }
  addClusterMergeLog(id: string, from: string, into: string, createdAt: number): void {
    this.db
      .prepare(`INSERT INTO cluster_merge_log (id, from_cluster, into_cluster, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, from, into, createdAt);
  }

  // ---- P2: 動画プロキシ ----
  setVideoProxyPath(id: string, proxyPath: string): void {
    this.db.prepare(`UPDATE media_item SET video_proxy_path = ? WHERE id = ?`).run(proxyPath, id);
  }
  getVideoProxyPath(id: string): string | null {
    const r = this.db.prepare(`SELECT video_proxy_path FROM media_item WHERE id = ?`).get(id) as any;
    return r?.video_proxy_path ?? null;
  }
  listVideosWithoutProxy(limit?: number): MediaItem[] {
    const rows = limit
      ? this.db
          .prepare(`SELECT * FROM media_item WHERE media_type = 'video' AND video_proxy_path IS NULL LIMIT ?`)
          .all(limit)
      : this.db.prepare(`SELECT * FROM media_item WHERE media_type = 'video' AND video_proxy_path IS NULL`).all();
    return (rows as any[]).map(rowToMedia);
  }

  // ---- P2: ルート命名テンプレート ----
  setRootTemplate(rootId: string, templateJson: string): void {
    this.db.prepare(`UPDATE root_folder SET naming_template = ? WHERE id = ?`).run(templateJson, rootId);
  }
  getRootTemplate(rootId: string): string | null {
    const r = this.db.prepare(`SELECT naming_template FROM root_folder WHERE id = ?`).get(rootId) as any;
    return r?.naming_template ?? null;
  }

  // ---- P2: デバイス ----
  addDevice(d: Device): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO device (id, name, token, created_at, last_seen, revoked) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(d.id, d.name, d.token, d.createdAt, d.lastSeen, d.revoked ? 1 : 0);
  }
  getDeviceByToken(token: string): Device | null {
    const r = this.db.prepare(`SELECT * FROM device WHERE token = ? AND revoked = 0`).get(token) as any;
    return r ? rowToDevice(r) : null;
  }
  listDevices(): Device[] {
    return (this.db.prepare(`SELECT * FROM device ORDER BY created_at DESC`).all() as any[]).map(rowToDevice);
  }
  revokeDevice(id: string): void {
    this.db.prepare(`UPDATE device SET revoked = 1 WHERE id = ?`).run(id);
  }
  touchDevice(id: string, lastSeen: number): void {
    this.db.prepare(`UPDATE device SET last_seen = ? WHERE id = ?`).run(lastSeen, id);
  }

  close(): void {
    this.db.close();
  }
}

function rowToPerson(r: any): Person {
  return {
    id: r.id,
    clusterId: r.cluster_id,
    displayName: r.display_name ?? undefined,
    coverFaceId: r.cover_face_id ?? undefined,
    isFavorite: !!r.is_favorite,
    confirmed: !!r.confirmed,
    mergedInto: r.merged_into ?? undefined,
    personKey: r.person_key ?? undefined,
  };
}

function rowToFeedback(r: any): FaceFeedback {
  return { id: r.id, faceId: r.face_id, personId: r.person_id, verdict: r.verdict, createdAt: r.created_at };
}

function rowToDevice(r: any): Device {
  return {
    id: r.id,
    name: r.name ?? '',
    token: r.token,
    createdAt: r.created_at,
    lastSeen: r.last_seen,
    revoked: !!r.revoked,
  };
}

// ---- 行 -> ドメイン変換 ----

function rowToRoot(r: any): RootFolder {
  return {
    id: r.id,
    path: r.path,
    driveId: r.drive_id ?? undefined,
    isOnline: !!r.is_online,
    managedByOtherApp: !!r.managed_by_other_app,
  };
}

function rowToMedia(r: any): MediaItem {
  return {
    id: r.id,
    rootId: r.root_id,
    sourceRef: r.source_ref,
    mediaType: r.media_type,
    createdAt: r.created_at,
    dateUncertain: !!r.date_uncertain,
    ...(r.gps_lat != null && r.gps_lng != null ? { gps: { lat: r.gps_lat, lng: r.gps_lng } } : {}),
    ...(r.place_name ? { placeName: r.place_name } : {}),
    width: r.width,
    height: r.height,
    ...(r.duration_ms != null ? { durationMs: r.duration_ms } : {}),
    orientation: r.orientation,
    contentHash: r.content_hash,
    perceptualHash: r.perceptual_hash,
    thumbPath: r.thumb_path ?? '',
    previewPath: r.preview_path ?? '',
    analysisStatus: r.analysis_status,
  };
}

function rowToFace(r: any): Face {
  const buf: Buffer = r.embedding;
  const embedding = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return {
    id: r.id,
    mediaId: r.media_id,
    bbox: JSON.parse(r.bbox) as BBox,
    quality: r.quality,
    eyesOpen: !!r.eyes_open,
    embedding: Float32Array.from(embedding),
    ...(r.cluster_id ? { clusterId: r.cluster_id } : {}),
  };
}

function rowToJob(r: any): Job {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    progress: r.progress,
    total: r.total,
    resumable: !!r.resumable,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.error ? { error: r.error } : {}),
  };
}

function rowToItem(r: any): RestructureItemRow {
  return {
    planId: r.plan_id,
    mediaId: r.media_id,
    fromPath: r.from_path,
    toPath: r.to_path,
    sameDrive: !!r.same_drive,
    ...(r.checksum ? { checksum: r.checksum } : {}),
    state: r.state,
    ...(r.error ? { error: r.error } : {}),
  };
}

function rowToJournal(r: any): OperationJournalEntry {
  return {
    id: r.id,
    refType: r.ref_type,
    refId: r.ref_id,
    op: r.op,
    fromPath: r.from_path,
    toPath: r.to_path,
    executedAt: r.executed_at,
    reversible: !!r.reversible,
    ...(r.undo_ref ? { undoRef: r.undo_ref } : {}),
  };
}

function rowToStory(r: any): Story {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind,
    startAt: r.start_at,
    endAt: r.end_at,
    ...(r.place_name ? { placeName: r.place_name } : {}),
    ...(r.cover_media_id ? { coverMediaId: r.cover_media_id } : {}),
  };
}
