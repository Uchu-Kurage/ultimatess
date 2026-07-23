// ============================================================================
// 動画プロキシ生成 (P2 §A-4 / M8)。
// ブラウザ再生できない HEVC 等を H.264/AAC の MP4 へ変換し、キャッシュへ保存。
// 再開可能ジョブ基盤に載せる（既に proxy を持つ動画はスキップ → 再実行で続きから）。
// ffmpeg 実装は抽象化し、テストではフェイクを注入する。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MediaItem } from '../../shared/types.js';
import type { JobContext } from '../jobs/jobOrchestrator.js';
import type { Store } from '../store/store.js';

export interface VideoProxyGenerator {
  /** src の H.264/AAC mp4 を outPath に生成する。 */
  generate(src: string, outPath: string): Promise<void>;
}

/** ffmpeg-static + fluent-ffmpeg による本番実装。 */
export class FfmpegProxyGenerator implements VideoProxyGenerator {
  async generate(src: string, outPath: string): Promise<void> {
    const ffmpeg = (await import('fluent-ffmpeg')).default;
    const ffmpegStatic = (await import('ffmpeg-static')).default as unknown as string;
    if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    const tmp = `${outPath}.part`;
    await new Promise<void>((resolve, reject) => {
      ffmpeg(src)
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions(['-movflags +faststart', '-preset veryfast', '-crf 23'])
        .on('end', () => resolve())
        .on('error', reject)
        .save(tmp);
    });
    await fs.rename(tmp, outPath);
  }
}

export class VideoProxyBatch {
  constructor(
    private readonly store: Store,
    private readonly generator: VideoProxyGenerator,
    private readonly cacheDir: string,
  ) {}

  async run(ctx?: JobContext): Promise<void> {
    const targets = this.store.listVideosWithoutProxy();
    const total = targets.length;
    ctx?.setProgress(0, total);
    for (let i = 0; i < targets.length; i++) {
      if (ctx) await ctx.checkpoint();
      const m: MediaItem = targets[i];
      const out = path.join(this.cacheDir, 'proxy', `${m.contentHash || m.id}.mp4`);
      try {
        await this.generator.generate(m.sourceRef, out);
        this.store.setVideoProxyPath(m.id, out);
      } catch {
        // 失敗は記録せずスキップ（再実行で再試行）。
      }
      ctx?.setProgress(i + 1, total);
    }
  }
}
