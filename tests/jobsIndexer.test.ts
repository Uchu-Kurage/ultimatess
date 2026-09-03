import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach } from 'vitest';
import { InMemoryStore } from '../app/core/store/inMemoryStore.js';
import { JobOrchestrator, type JobContext } from '../app/core/jobs/jobOrchestrator.js';
import { Indexer } from '../app/core/index/indexer.js';
import { LocalFolderProvider } from '../app/core/source/sourceProvider.js';
import type { MediaProbe, ProbeResult } from '../app/core/index/mediaProbe.js';
import type { ScannedFile } from '../app/core/source/sourceProvider.js';
import { newId } from '../app/shared/util.js';
import type { RootFolder } from '../app/shared/types.js';
import { tmpDir, writeFile } from './helpers.js';

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true }).catch(() => {});
});

function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

describe('JobOrchestrator', () => {
  it('進捗を報告し done で完了する', async () => {
    const store = new InMemoryStore();
    const orch = new JobOrchestrator(store);
    const progresses: number[] = [];
    orch.onProgress((_, __, p) => progresses.push(p));
    orch.register('index', async (ctx: JobContext) => {
      for (let i = 0; i < 5; i++) {
        await ctx.checkpoint();
        ctx.setProgress(i + 1, 5);
      }
    });
    const id = orch.enqueue('index', {});
    // pump は非同期。完了まで待つ。
    for (let i = 0; i < 50 && store.getJob(id)?.status !== 'done'; i++) await tick();
    expect(store.getJob(id)!.status).toBe('done');
    expect(progresses.at(-1)).toBe(5);
  });

  it('pause 中は進まず、resume で再開する', async () => {
    const store = new InMemoryStore();
    const orch = new JobOrchestrator(store);
    let processed = 0;
    let started = false;
    orch.register('analyze', async (ctx) => {
      started = true;
      for (let i = 0; i < 3; i++) {
        await ctx.checkpoint();
        processed++;
        ctx.setProgress(i + 1, 3);
      }
    });
    const id = orch.enqueue('analyze', {});
    // 最初のチェックポイント通過後に pause させる（マイクロタスクを流し切る前に予約）。
    orch.pause(id);
    // pause 済みなので、待っても完了しない。
    await tick();
    await tick();
    expect(started).toBe(true);
    expect(store.getJob(id)!.status).toBe('paused');
    expect(processed).toBeLessThan(3);
    orch.resume(id);
    for (let i = 0; i < 50 && store.getJob(id)?.status !== 'done'; i++) await tick();
    expect(store.getJob(id)!.status).toBe('done');
    expect(processed).toBe(3);
  });

  it('recoverOnStartup が running のジョブを再開する', async () => {
    const store = new InMemoryStore();
    // 前回セッションで running のまま中断したジョブを模擬。
    store.createJob({
      id: 'job_x',
      kind: 'index',
      status: 'running',
      progress: 2,
      total: 5,
      resumable: true,
      createdAt: 0,
      updatedAt: 0,
    });
    const orch = new JobOrchestrator(store);
    orch.register('index', async (ctx) => {
      ctx.setProgress(5, 5);
    });
    await orch.recoverOnStartup();
    for (let i = 0; i < 50 && store.getJob('job_x')?.status !== 'done'; i++) await tick();
    expect(store.getJob('job_x')!.status).toBe('done');
  });
});

// 差分検出・再開できる索引を確認。
class FakeProbe implements MediaProbe {
  async probe(file: ScannedFile): Promise<ProbeResult> {
    return {
      mediaType: 'photo',
      width: 100,
      height: 100,
      createdAt: file.mtime,
      dateUncertain: false,
      orientation: 1,
      contentHash: 'ch-' + file.path,
      perceptualHash: '0000000000000000',
      thumbPath: '',
      previewPath: '',
    };
  }
}

// サムネ有無を切り替えられる Probe（rebuild 前後を模擬）。
class SwitchableProbe implements MediaProbe {
  thumbs = false;
  async probe(file: ScannedFile): Promise<ProbeResult> {
    return {
      mediaType: 'photo',
      width: 100,
      height: 100,
      createdAt: file.mtime,
      dateUncertain: false,
      orientation: 1,
      contentHash: 'ch-' + file.path,
      perceptualHash: '0000000000000000',
      thumbPath: this.thumbs ? '/cache/thumb/' + file.path + '.jpg' : '',
      previewPath: this.thumbs ? '/cache/preview/' + file.path + '.jpg' : '',
    };
  }
}

describe('Indexer 差分・再開', () => {
  it('走査してメディアを投入し、再実行では重複なくスキップ', async () => {
    const base = await tmpDir();
    cleanups.push(base);
    await writeFile(path.join(base, 'a.jpg'), 'a');
    await writeFile(path.join(base, 'sub', 'b.jpg'), 'b');
    await writeFile(path.join(base, 'notes.txt'), 'ignore me');

    const store = new InMemoryStore();
    const root: RootFolder = {
      id: newId('root'),
      path: base,
      isOnline: true,
      managedByOtherApp: false,
    };
    store.addRoot(root);
    const indexer = new Indexer(store, new LocalFolderProvider(), new FakeProbe());

    const r1 = await indexer.indexRoot(root.id);
    expect(r1.added).toBe(2); // jpg 2 枚（txt は無視）
    expect(store.countMedia()).toBe(2);

    // もう一度: 既存はスキップ、追加ゼロ。
    const r2 = await indexer.indexRoot(root.id);
    expect(r2.added).toBe(0);
    expect(r2.skipped).toBe(2);
    expect(store.countMedia()).toBe(2);

    // 新規ファイル追加 → 差分のみ追加。
    await writeFile(path.join(base, 'c.jpg'), 'c');
    const r3 = await indexer.indexRoot(root.id);
    expect(r3.added).toBe(1);
    expect(store.countMedia()).toBe(3);
  });

  it('派生アセット欠落の既存行を再実行で修復する（サムネ再生成）', async () => {
    const base = await tmpDir();
    cleanups.push(base);
    await writeFile(path.join(base, 'a.jpg'), 'a');

    const store = new InMemoryStore();
    const root: RootFolder = {
      id: newId('root'),
      path: base,
      isOnline: true,
      managedByOtherApp: false,
    };
    store.addRoot(root);

    // 初回は sharp 未リビルド相当で thumb/preview が空。
    const probe = new SwitchableProbe();
    const indexer = new Indexer(store, new LocalFolderProvider(), probe);
    const r1 = await indexer.indexRoot(root.id);
    expect(r1.added).toBe(1);
    const idFirst = store.listMedia(0, 10)[0].id;
    expect(store.getMedia(idFirst)!.thumbPath).toBe('');

    // rebuild 後相当: probe がサムネを返すようになる → 再実行で欠落行を修復。
    probe.thumbs = true;
    const r2 = await indexer.indexRoot(root.id);
    expect(r2.added).toBe(0);
    expect(r2.updated).toBe(1);
    expect(r2.skipped).toBe(0);
    const repaired = store.getMedia(idFirst)!;
    expect(repaired.thumbPath).not.toBe('');
    expect(repaired.previewPath).not.toBe('');

    // さらに再実行すると、もう欠落していないのでスキップ。
    const r3 = await indexer.indexRoot(root.id);
    expect(r3.updated).toBe(0);
    expect(r3.skipped).toBe(1);
  });

  it('managedByOtherApp のライブラリ配下は走査しない', async () => {
    const base = await tmpDir();
    cleanups.push(base);
    await writeFile(path.join(base, 'Photos.photoslibrary', 'x.jpg'), 'x');
    await writeFile(path.join(base, 'ok.jpg'), 'ok');
    const store = new InMemoryStore();
    const root: RootFolder = {
      id: newId('root'),
      path: base,
      isOnline: true,
      managedByOtherApp: false,
    };
    store.addRoot(root);
    const indexer = new Indexer(store, new LocalFolderProvider(), new FakeProbe());
    const r = await indexer.indexRoot(root.id);
    expect(r.added).toBe(1); // .photoslibrary 内は除外
  });
});
