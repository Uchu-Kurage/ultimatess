// ============================================================================
// MediaProbe — 原本からメタデータ・派生（サムネ/知覚ハッシュ）を抽出する抽象。
// 本番は NodeMediaProbe(sharp/exifr/ffmpeg)。テストはフェイクを注入する。
// この抽象化により Indexer をネイティブ依存なしでテストできる。
// ============================================================================

import type { Gps, MediaType } from '../../shared/types.js';
import type { ScannedFile } from '../source/sourceProvider.js';

export interface ProbeResult {
  mediaType: MediaType;
  width: number;
  height: number;
  /** EXIF 撮影日時(ms)。無ければ null。 */
  createdAt: number | null;
  /** createdAt を mtime で代替した場合 true（日付不確実 §5.6）。 */
  dateUncertain: boolean;
  gps?: Gps;
  durationMs?: number;
  orientation: number;
  contentHash: string;
  perceptualHash: string;
  thumbPath: string;
  previewPath: string;
}

export interface MediaProbe {
  probe(file: ScannedFile): Promise<ProbeResult>;
}
