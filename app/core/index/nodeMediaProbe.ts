// ============================================================================
// NodeMediaProbe — 本番のメタ/派生抽出 (sharp + exifr + ffmpeg)。
// 写真: EXIF 日時/GPS・寸法・向き・知覚ハッシュ・多段サムネ。
// 動画: ffprobe で尺/寸法、代表フレームをサムネ化。
// 派生は構造化キャッシュ(cacheDir)へ書き出す（＝スマホ参照対象 §5.11）。
// ============================================================================

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ProbeResult } from './mediaProbe.js';
import type { MediaProbe } from './mediaProbe.js';
import { mediaTypeForExt } from '../source/sourceProvider.js';
import { dhashFromGray } from '../analysis/perceptualHash.js';

export class NodeMediaProbe implements MediaProbe {
  constructor(private readonly cacheDir: string) {}

  async probe(file: { path: string; mtime: number; size: number }): Promise<ProbeResult> {
    const ext = path.extname(file.path);
    const type = mediaTypeForExt(ext) ?? 'photo';
    const contentHash = await this.hashFile(file.path);
    if (type === 'video') return this.probeVideo(file, contentHash);
    return this.probePhoto(file, contentHash);
  }

  private async probePhoto(
    file: { path: string; mtime: number },
    contentHash: string,
  ): Promise<ProbeResult> {
    const sharp = (await import('sharp')).default;
    const exifr = (await import('exifr')).default;

    let width = 0;
    let height = 0;
    let orientation = 1;
    try {
      const meta = await sharp(file.path).metadata();
      width = meta.width ?? 0;
      height = meta.height ?? 0;
      orientation = meta.orientation ?? 1;
    } catch {
      /* デコード不能でも索引は継続 */
    }

    let createdAt: number | null = null;
    let gps: { lat: number; lng: number } | undefined;
    try {
      const ex = await exifr.parse(file.path, { gps: true }).catch(() => null);
      const dt = ex?.DateTimeOriginal ?? ex?.CreateDate;
      if (dt instanceof Date) createdAt = dt.getTime();
      if (typeof ex?.latitude === 'number' && typeof ex?.longitude === 'number') {
        gps = { lat: ex.latitude, lng: ex.longitude };
      }
    } catch {
      /* EXIF 無しはフォールバック */
    }
    const dateUncertain = createdAt == null;
    if (createdAt == null) createdAt = Math.round(file.mtime); // §5.6 mtime 代替

    const perceptualHash = await this.computePhash(sharp, file.path);
    const thumbPath = await this.writeThumb(sharp, file.path, contentHash, 320);
    const previewPath = await this.writeThumb(sharp, file.path, contentHash, 1280);

    return {
      mediaType: 'photo',
      width,
      height,
      createdAt,
      dateUncertain,
      ...(gps ? { gps } : {}),
      orientation,
      contentHash,
      perceptualHash,
      thumbPath,
      previewPath,
    };
  }

  private async probeVideo(
    file: { path: string; mtime: number },
    contentHash: string,
  ): Promise<ProbeResult> {
    let width = 0;
    let height = 0;
    let durationMs: number | undefined;
    let createdAt: number | null = null;
    try {
      const info = await this.ffprobe(file.path);
      width = info.width;
      height = info.height;
      durationMs = info.durationMs;
      createdAt = info.createdAt;
    } catch {
      /* ffprobe 失敗時も索引は継続 */
    }
    const dateUncertain = createdAt == null;
    if (createdAt == null) createdAt = Math.round(file.mtime);

    const thumbPath = await this.writeVideoThumb(file.path, contentHash).catch(() => '');

    return {
      mediaType: 'video',
      width,
      height,
      createdAt,
      dateUncertain,
      ...(durationMs != null ? { durationMs } : {}),
      orientation: 1,
      contentHash,
      perceptualHash: '',
      thumbPath,
      previewPath: thumbPath,
    };
  }

  private hashFile(p: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const h = createHash('sha256');
      const rs = createReadStream(p);
      rs.on('error', reject);
      rs.on('data', (d) => h.update(d));
      rs.on('end', () => resolve(h.digest('hex')));
    });
  }

  private async computePhash(sharp: any, p: string): Promise<string> {
    try {
      const w = 9;
      const h = 8;
      const raw = await sharp(p).grayscale().resize(w, h, { fit: 'fill' }).raw().toBuffer();
      return dhashFromGray(raw, w, h);
    } catch {
      return '';
    }
  }

  private async writeThumb(sharp: any, src: string, hash: string, size: number): Promise<string> {
    const dir = path.join(this.cacheDir, size <= 320 ? 'thumb' : 'preview');
    await fs.mkdir(dir, { recursive: true });
    const out = path.join(dir, `${hash}_${size}.jpg`);
    try {
      await sharp(src).rotate().resize(size, size, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(out);
      return out;
    } catch {
      return '';
    }
  }

  private async writeVideoThumb(src: string, hash: string): Promise<string> {
    const ffmpeg = (await import('fluent-ffmpeg')).default;
    const ffmpegStatic = (await import('ffmpeg-static')).default as unknown as string;
    if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);
    const dir = path.join(this.cacheDir, 'thumb');
    await fs.mkdir(dir, { recursive: true });
    const out = path.join(dir, `${hash}_video.jpg`);
    await new Promise<void>((resolve, reject) => {
      ffmpeg(src)
        .on('end', () => resolve())
        .on('error', reject)
        .screenshots({ count: 1, timemarks: ['1'], filename: path.basename(out), folder: dir, size: '640x?' });
    });
    return out;
  }

  private async ffprobe(
    src: string,
  ): Promise<{ width: number; height: number; durationMs: number; createdAt: number | null }> {
    const ffmpeg = (await import('fluent-ffmpeg')).default;
    const ffmpegStatic = (await import('ffmpeg-static')).default as unknown as string;
    if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(src, (err: unknown, data: any) => {
        if (err) return reject(err as Error);
        const stream = (data.streams ?? []).find((s: any) => s.width && s.height) ?? {};
        const durationSec = Number(data.format?.duration ?? 0);
        const tagDate = data.format?.tags?.creation_time;
        const createdAt = tagDate ? Date.parse(tagDate) : null;
        resolve({
          width: stream.width ?? 0,
          height: stream.height ?? 0,
          durationMs: Math.round(durationSec * 1000),
          createdAt: Number.isNaN(createdAt as number) ? null : createdAt,
        });
      });
    });
  }
}
