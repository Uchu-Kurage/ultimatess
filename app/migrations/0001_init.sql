-- P1 §5 データベーススキーマ。better-sqlite3 で適用される。
-- すべて PC 内・ローカル。原本は非保持（source_ref で参照）。

CREATE TABLE IF NOT EXISTS root_folder (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  drive_id TEXT,
  is_online INTEGER DEFAULT 1,
  managed_by_other_app INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS media_item (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  source_ref TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  created_at INTEGER,
  date_uncertain INTEGER DEFAULT 0,
  gps_lat REAL,
  gps_lng REAL,
  place_name TEXT,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  orientation INTEGER,
  content_hash TEXT,
  perceptual_hash TEXT,
  thumb_path TEXT,
  preview_path TEXT,
  analysis_status TEXT DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_media_created ON media_item(created_at);
CREATE INDEX IF NOT EXISTS idx_media_status  ON media_item(analysis_status);
CREATE INDEX IF NOT EXISTS idx_media_phash   ON media_item(perceptual_hash);
CREATE INDEX IF NOT EXISTS idx_media_root    ON media_item(root_id);
CREATE INDEX IF NOT EXISTS idx_media_chash   ON media_item(content_hash);

CREATE TABLE IF NOT EXISTS face (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL,
  bbox TEXT,
  embedding BLOB,
  quality REAL,
  eyes_open INTEGER,
  cluster_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_face_media   ON face(media_id);
CREATE INDEX IF NOT EXISTS idx_face_cluster ON face(cluster_id);

CREATE TABLE IF NOT EXISTS person (
  id TEXT PRIMARY KEY,
  cluster_id TEXT,
  display_name TEXT,
  cover_face_id TEXT,
  is_favorite INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS quality_score (
  media_id TEXT PRIMARY KEY,
  sharpness REAL,
  exposure REAL,
  composition REAL,
  eyes_open REAL,
  composite REAL
);

CREATE TABLE IF NOT EXISTS scene_label (
  media_id TEXT,
  label TEXT,
  confidence REAL
);
CREATE INDEX IF NOT EXISTS idx_scene_media ON scene_label(media_id);

CREATE TABLE IF NOT EXISTS duplicate_group (
  id TEXT PRIMARY KEY,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS duplicate_member (
  group_id TEXT,
  media_id TEXT,
  is_representative INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dupmember_group ON duplicate_member(group_id);

-- ジョブ & 物理再配置 --------------------------------------------------------

CREATE TABLE IF NOT EXISTS job (
  id TEXT PRIMARY KEY,
  kind TEXT,
  status TEXT,
  progress INTEGER DEFAULT 0,
  total INTEGER DEFAULT 0,
  resumable INTEGER DEFAULT 1,
  created_at INTEGER,
  updated_at INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_status ON job(status);

CREATE TABLE IF NOT EXISTS restructure_plan (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  status TEXT,
  target_root TEXT,
  space_required INTEGER
);

CREATE TABLE IF NOT EXISTS restructure_item (
  plan_id TEXT,
  media_id TEXT,
  from_path TEXT,
  to_path TEXT,
  same_drive INTEGER,
  checksum TEXT,
  state TEXT DEFAULT 'pending', -- pending|renamed|copied|verified|source_trashed|done|failed
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_restructure_state ON restructure_item(plan_id, state);

CREATE TABLE IF NOT EXISTS operation_journal (
  id TEXT PRIMARY KEY,
  ref_type TEXT,
  ref_id TEXT,
  op TEXT,
  from_path TEXT,
  to_path TEXT,
  executed_at INTEGER,
  reversible INTEGER DEFAULT 1,
  undo_ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_journal_ref ON operation_journal(ref_type, ref_id);

-- スライドショー ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS story (
  id TEXT PRIMARY KEY,
  title TEXT,
  kind TEXT,
  start_at INTEGER,
  end_at INTEGER,
  place_name TEXT,
  cover_media_id TEXT
);
CREATE TABLE IF NOT EXISTS story_item (
  story_id TEXT,
  media_id TEXT,
  ord INTEGER,
  role TEXT
);
CREATE INDEX IF NOT EXISTS idx_storyitem_story ON story_item(story_id);

CREATE TABLE IF NOT EXISTS timeline (
  id TEXT PRIMARY KEY,
  story_id TEXT,
  generated_at INTEGER,
  music_track_id TEXT,
  config TEXT
);
CREATE INDEX IF NOT EXISTS idx_timeline_story ON timeline(story_id);

CREATE TABLE IF NOT EXISTS timeline_clip (
  timeline_id TEXT,
  media_id TEXT,
  ord INTEGER,
  start_ms INTEGER,
  duration_ms INTEGER,
  kb_start_rect TEXT,
  kb_end_rect TEXT,
  transition_in TEXT
);
CREATE INDEX IF NOT EXISTS idx_clip_timeline ON timeline_clip(timeline_id);

CREATE TABLE IF NOT EXISTS music_track (
  id TEXT PRIMARY KEY,
  source TEXT,
  title TEXT,
  path TEXT,
  bpm REAL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
