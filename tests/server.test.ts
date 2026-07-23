// ============================================================================
// M7/M8 ローカルサーバー: 認証（未認証拒否）・ペアリング・派生配信・
// パストラバーサル対策・HTTP Range。受け入れ(§E): 破壊的操作不可・LAN内・原本非配信。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { InMemoryStore } from '../app/core/store/inMemoryStore.js';
import { MediaServer } from '../app/core/server/mediaServer.js';
import type { MediaItem, Story } from '../app/shared/types.js';

let server: MediaServer;
let base: string;
let cacheDir: string;
let port: number;
let store: InMemoryStore;

async function writeFile(p: string, content: string) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}

function addMedia(s: InMemoryStore, over: Partial<MediaItem>): MediaItem {
  const m: MediaItem = {
    id: over.id ?? 'm1',
    rootId: 'r',
    sourceRef: over.sourceRef ?? '/orig/secret.HEIC',
    mediaType: over.mediaType ?? 'photo',
    createdAt: 0,
    dateUncertain: false,
    width: 10,
    height: 10,
    orientation: 1,
    contentHash: 'c',
    perceptualHash: '0',
    thumbPath: over.thumbPath ?? '',
    previewPath: over.previewPath ?? '',
    analysisStatus: 'done',
    ...over,
  };
  s.upsertMedia(m);
  return m;
}

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-'));
  cacheDir = path.join(base, 'cache');
  await fs.mkdir(cacheDir, { recursive: true });
  store = new InMemoryStore();
  server = new MediaServer({ store, cacheDir });
  const res = await server.listen(0, '127.0.0.1');
  port = res.port;
});

afterEach(async () => {
  await server.close();
  await fs.rm(base, { recursive: true, force: true });
});

function url(p: string) {
  return `http://127.0.0.1:${port}${p}`;
}

async function pair(): Promise<string> {
  const { pin } = server.pairingManager().generatePin();
  const res = await fetch(url('/pair'), {
    method: 'POST',
    body: JSON.stringify({ pin, name: 'iphone' }),
  });
  const body = (await res.json()) as { token: string };
  return body.token;
}

describe('認証', () => {
  it('未認証の API は 401', async () => {
    const res = await fetch(url('/api/stories'));
    expect(res.status).toBe(401);
  });

  it('誤った PIN でのペアリングは 403', async () => {
    server.pairingManager().generatePin();
    const res = await fetch(url('/pair'), { method: 'POST', body: JSON.stringify({ pin: '000000' }) });
    // ランダム PIN と一致する確率は極小。ほぼ確実に 403。
    expect([403]).toContain(res.status);
  });

  it('正しい PIN でトークン発行 → API に到達できる', async () => {
    const token = await pair();
    expect(token).toBeTruthy();
    const res = await fetch(url('/api/stories'), { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });

  it('書き込み系メソッド(POST 以外の /api)は 405（閲覧専用）', async () => {
    const token = await pair();
    const res = await fetch(url('/api/stories'), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(405);
  });
});

describe('派生配信とパストラバーサル対策', () => {
  it('cache 配下のサムネは配信、cache 外を指すパスは 403', async () => {
    const token = await pair();
    const thumb = path.join(cacheDir, 'thumb', 't1.jpg');
    await writeFile(thumb, 'THUMBDATA');
    addMedia(store, { id: 'ok', thumbPath: thumb });

    // cache 外（原本など）を指すメディアは配信拒否。
    const outside = path.join(base, 'outside.jpg');
    await writeFile(outside, 'SECRET-ORIGINAL');
    addMedia(store, { id: 'bad', thumbPath: outside });

    const good = await fetch(url('/media/ok/thumb'), { headers: { Authorization: `Bearer ${token}` } });
    expect(good.status).toBe(200);
    expect(await good.text()).toBe('THUMBDATA');

    const bad = await fetch(url('/media/bad/thumb'), { headers: { Authorization: `Bearer ${token}` } });
    expect(bad.status).toBe(403); // トラバーサル/原本流出を構造的に阻止
  });

  it('存在しないメディアは 404、未生成アセットは 404', async () => {
    const token = await pair();
    addMedia(store, { id: 'noassets', thumbPath: '' });
    const r1 = await fetch(url('/media/nope/thumb'), { headers: { Authorization: `Bearer ${token}` } });
    expect(r1.status).toBe(404);
    const r2 = await fetch(url('/media/noassets/thumb'), { headers: { Authorization: `Bearer ${token}` } });
    expect(r2.status).toBe(404);
  });
});

describe('動画プロキシ Range 配信', () => {
  it('Range リクエストに 206 + Content-Range で応答する', async () => {
    const token = await pair();
    const proxy = path.join(cacheDir, 'proxy', 'v1.mp4');
    const content = 'ABCDEFGHIJ'; // 10 bytes
    await writeFile(proxy, content);
    addMedia(store, { id: 'vid', mediaType: 'video' });
    store.setVideoProxyPath('vid', proxy);

    const res = await fetch(url('/media/vid/video'), {
      headers: { Authorization: `Bearer ${token}`, Range: 'bytes=2-5' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(await res.text()).toBe('CDEF');
  });

  it('範囲外 Range は 416', async () => {
    const token = await pair();
    const proxy = path.join(cacheDir, 'proxy', 'v2.mp4');
    await writeFile(proxy, 'SHORT');
    addMedia(store, { id: 'vid2', mediaType: 'video' });
    store.setVideoProxyPath('vid2', proxy);
    const res = await fetch(url('/media/vid2/video'), {
      headers: { Authorization: `Bearer ${token}`, Range: 'bytes=999-1000' },
    });
    expect(res.status).toBe(416);
  });
});

describe('スマホ Web クライアント配信', () => {
  it('/ は認証なしで HTML シェルを返す（クライアント自体が認証UIを持つ）', async () => {
    // mobileIndexPath 付きのサーバを別途起動。
    const idx = path.join(base, 'mobile.html');
    await writeFile(idx, '<!doctype html><title>m</title>');
    const s2 = new MediaServer({ store, cacheDir, mobileIndexPath: idx });
    const r = await s2.listen(0, '127.0.0.1');
    try {
      const res = await fetch(`http://127.0.0.1:${r.port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
    } finally {
      await s2.close();
    }
  });
});

describe('ストーリー配信（原本を含まない DTO）', () => {
  it('/api/stories は要約 DTO を返す', async () => {
    const token = await pair();
    const story: Story = {
      id: 's1',
      title: '夏の思い出',
      kind: 'event',
      startAt: 0,
      endAt: 1000,
      coverMediaId: 'm1',
    };
    store.createStory(story);
    store.replaceStoryItems('s1', [{ storyId: 's1', mediaId: 'm1', order: 0, role: 'hero' }]);

    const res = await fetch(url('/api/stories'), { headers: { Authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { items: { id: string; itemCount: number; title: string }[] };
    expect(body.items[0].id).toBe('s1');
    expect(body.items[0].itemCount).toBe(1);
    // 原本パスは含まれない。
    expect(JSON.stringify(body)).not.toContain('sourceRef');
  });
});
