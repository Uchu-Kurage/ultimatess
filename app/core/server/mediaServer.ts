// ============================================================================
// ローカル HTTP サーバー (P2 §A / M7・M8)。core(utilityProcess)内に置く。
//
// 原則(§0):
//  - スマホは閲覧専用。書き込み系 API は一切公開しない。
//  - 通信は LAN 内に閉じる（ポート開放しない前提でバインド）。
//  - 原本は配信しない。派生アセット（サムネ/プレビュー/動画プロキシ）のみ。
//    しかも「キャッシュディレクトリ配下」に限定し、ID→パス解決のみ受け付ける
//    ことでパストラバーサルを構造的に不可能にする(§A-4)。
// ============================================================================

import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import type {
  PersonDTO,
  StorySummaryDTO,
  Timeline,
} from '../../shared/types.js';
import { DirectionEngine } from '../direction/directionEngine.js';
import { PersonEngine } from '../persons/personEngine.js';
import type { Store } from '../store/store.js';
import { PairingManager } from './pairing.js';

export interface MediaServerDeps {
  store: Store;
  /** 派生アセットを配信して良いベースディレクトリ（この配下のみ）。 */
  cacheDir: string;
  /** 音楽ファイルの配信を許すベース（任意）。 */
  musicDir?: string;
  /** スマホ Web クライアント(自己完結 HTML)のパス。'/' で公開配信する。 */
  mobileIndexPath?: string;
}

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
};

export class MediaServer {
  private server: http.Server | null = null;
  private pairing: PairingManager;
  private persons: PersonEngine;
  private direction: DirectionEngine;

  constructor(private readonly deps: MediaServerDeps) {
    this.pairing = new PairingManager(deps.store);
    this.persons = new PersonEngine(deps.store);
    this.direction = new DirectionEngine(deps.store);
  }

  pairingManager(): PairingManager {
    return this.pairing;
  }

  listen(port: number, host = '0.0.0.0'): Promise<{ port: number }> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
    });
    return new Promise((resolve) => {
      this.server!.listen(port, host, () => {
        const addr = this.server!.address();
        resolve({ port: typeof addr === 'object' && addr ? addr.port : port });
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  // --------------------------------------------------------------------------
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    // スマホ Web クライアントの外殻は公開配信（これ自体が認証 UI を持つ）。
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return this.serveMobileShell(res);
    }

    // ペアリングのみ未認証で許可。
    if (req.method === 'POST' && url.pathname === '/pair') {
      return this.handlePair(req, res);
    }

    // それ以外は全てトークン検証（書き込み系は存在しない = 閲覧専用）。
    const token = bearer(req.headers.authorization);
    const device = this.pairing.authenticate(token);
    if (!device) return this.json(res, 401, { error: 'unauthorized' });

    if (req.method !== 'GET') return this.json(res, 405, { error: 'read-only' });

    // GET /api/config
    if (url.pathname === '/api/config') return this.json(res, 200, { readOnly: true });

    // GET /api/stories
    if (url.pathname === '/api/stories') return this.handleStories(url, res);
    // GET /api/stories/:id
    if (parts[0] === 'api' && parts[1] === 'stories' && parts[2]) {
      return this.handleStoryDetail(parts[2], res);
    }
    // GET /api/timelines/:storyId
    if (parts[0] === 'api' && parts[1] === 'timelines' && parts[2]) {
      return this.handleTimeline(parts[2], res);
    }
    // GET /api/persons
    if (url.pathname === '/api/persons') return this.json(res, 200, this.personList());

    // GET /media/:id/thumb | preview | video
    if (parts[0] === 'media' && parts[1] && parts[2]) {
      return this.handleMedia(req, res, parts[1], parts[2], url);
    }
    // GET /music/:id
    if (parts[0] === 'music' && parts[1]) return this.handleMusic(req, res, parts[1]);

    return this.json(res, 404, { error: 'not found' });
  }

  private async serveMobileShell(res: http.ServerResponse): Promise<void> {
    if (!this.deps.mobileIndexPath) return this.json(res, 404, { error: 'mobile client not configured' });
    try {
      const html = await fs.readFile(this.deps.mobileIndexPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      this.json(res, 404, { error: 'mobile client missing' });
    }
  }

  private async handlePair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    let parsed: { pin?: string; name?: string };
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      return this.json(res, 400, { error: 'invalid json' });
    }
    const result = this.pairing.pair(parsed.pin ?? '', parsed.name ?? '');
    if (!result) return this.json(res, 403, { error: 'invalid pin' });
    return this.json(res, 200, result);
  }

  private handleStories(url: URL, res: http.ServerResponse): void {
    const cursor = Number(url.searchParams.get('cursor') ?? 0);
    const limit = Math.min(50, Number(url.searchParams.get('limit') ?? 30));
    const all = this.deps.store.listStories();
    const page = all.slice(cursor, cursor + limit);
    const items: StorySummaryDTO[] = page.map((s) => ({
      id: s.id,
      title: s.title,
      kind: s.kind,
      startAt: s.startAt,
      endAt: s.endAt,
      placeName: s.placeName,
      coverMediaId: s.coverMediaId,
      itemCount: this.deps.store.listStoryItems(s.id).length,
    }));
    const nextCursor = cursor + limit < all.length ? cursor + limit : null;
    this.json(res, 200, { items, nextCursor });
  }

  private handleStoryDetail(storyId: string, res: http.ServerResponse): void {
    const story = this.deps.store.getStory(storyId);
    if (!story) return this.json(res, 404, { error: 'not found' });
    const items = this.deps.store.listStoryItems(storyId);
    this.json(res, 200, { story, items });
  }

  private handleTimeline(storyId: string, res: http.ServerResponse): void {
    let tl: Timeline | null = this.deps.store.getTimelineByStory(storyId);
    if (!tl) {
      // 宣言的タイムライン(§A-5)はそのまま配れる。無ければ生成。
      void this.direction.generateTimeline(storyId).then((t) => this.json(res, 200, t));
      return;
    }
    this.json(res, 200, tl);
  }

  private personList(): PersonDTO[] {
    // 埋め込みは含めず、名前とカバーのみ(§B-6)。
    return this.persons.listPersons();
  }

  // ---- メディア配信（派生のみ・トラバーサル不可） ----
  private async handleMedia(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
    kind: string,
    url: URL,
  ): Promise<void> {
    const media = this.deps.store.getMedia(id);
    if (!media) return this.json(res, 404, { error: 'not found' });

    let filePath: string | null = null;
    if (kind === 'thumb') filePath = media.thumbPath || null;
    else if (kind === 'preview') filePath = media.previewPath || media.thumbPath || null;
    else if (kind === 'video') filePath = this.deps.store.getVideoProxyPath(id);
    if (!filePath) return this.json(res, 404, { error: 'asset not generated' });

    // 配信は cache 配下に限定（ID から解決したパスのみ・任意パスは受け付けない）。
    if (!this.isServable(filePath)) return this.json(res, 403, { error: 'forbidden' });
    void url; // size 選択などは将来拡張
    return this.serveFile(req, res, filePath, kind === 'video');
  }

  private async handleMusic(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
  ): Promise<void> {
    const track = this.deps.store.listMusicTracks().find((t) => t.id === id);
    if (!track) return this.json(res, 404, { error: 'not found' });
    if (!this.isServable(track.path)) return this.json(res, 403, { error: 'forbidden' });
    return this.serveFile(req, res, track.path, true);
  }

  /** 配信可能パスか（cacheDir / musicDir 配下のみ）。トラバーサル対策の要。 */
  private isServable(p: string): boolean {
    const resolved = path.resolve(p);
    const bases = [path.resolve(this.deps.cacheDir)];
    if (this.deps.musicDir) bases.push(path.resolve(this.deps.musicDir));
    return bases.some((base) => {
      const rel = path.relative(base, resolved);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
  }

  private async serveFile(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    filePath: string,
    allowRange: boolean,
  ): Promise<void> {
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return this.json(res, 404, { error: 'missing' });
    }
    const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const range = allowRange ? req.headers.range : undefined;

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
        if (start > end || start >= stat.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          return void res.end();
        }
        res.writeHead(206, {
          'Content-Type': type,
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': end - start + 1,
        });
        createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Accept-Ranges': allowRange ? 'bytes' : 'none',
    });
    createReadStream(filePath).pipe(res);
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(data);
  }
}

function bearer(auth: string | undefined): string | undefined {
  if (!auth) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1] : undefined;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
