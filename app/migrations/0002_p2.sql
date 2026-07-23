-- P2 スキーマ拡張。P1 の既存テーブル・安全性は変更しない（追加のみ）。

-- --- B. 人物機能 -----------------------------------------------------------
ALTER TABLE person ADD COLUMN confirmed INTEGER DEFAULT 0;
ALTER TABLE person ADD COLUMN merged_into TEXT;      -- 統合先 person_id
ALTER TABLE person ADD COLUMN person_key TEXT;       -- 安定した人物キー（clusterId から独立）

CREATE TABLE IF NOT EXISTS face_feedback (
  id TEXT PRIMARY KEY,
  face_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  verdict TEXT NOT NULL,          -- confirm | reject
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_feedback_face ON face_feedback(face_id);
CREATE INDEX IF NOT EXISTS idx_feedback_person ON face_feedback(person_id);

CREATE TABLE IF NOT EXISTS cluster_merge_log (
  id TEXT PRIMARY KEY, from_cluster TEXT, into_cluster TEXT, created_at INTEGER
);

-- --- A/M8. 動画プロキシ -----------------------------------------------------
ALTER TABLE media_item ADD COLUMN video_proxy_path TEXT;

-- --- A/M7. デバイス（ペアリング） ------------------------------------------
CREATE TABLE IF NOT EXISTS device (
  id TEXT PRIMARY KEY,
  name TEXT,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER,
  last_seen INTEGER,
  revoked INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_device_token ON device(token);

-- --- C/M11. 再配置テンプレート（ルートごと） --------------------------------
ALTER TABLE root_folder ADD COLUMN naming_template TEXT;
