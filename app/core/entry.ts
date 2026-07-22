// ============================================================================
// utilityProcess エントリ。重い処理を隔離するためのコアプロセス (P1 §3)。
// main とは parentPort の型付きメッセージ (shared/ipc.ts のワイヤ表現) で通信する。
// ============================================================================

import * as path from 'node:path';
import type {
  CoreInboundMessage,
  CoreOutboundMessage,
  IpcChannel,
  IpcRequest,
} from '../shared/ipc.js';
import { CoreApp } from './coreApp.js';
import { NodeFileOpAdapter } from './fileop/nodeFileOpAdapter.js';
import { NodeMediaProbe } from './index/nodeMediaProbe.js';
import { SqliteStore } from './store/sqlite/sqliteStore.js';

// Electron の utilityProcess では process.parentPort が使える。
const parentPort = (process as unknown as { parentPort: any }).parentPort;

function post(msg: CoreOutboundMessage): void {
  parentPort.postMessage(msg);
}

async function main(): Promise<void> {
  const dataDir = process.env.FM_DATA_DIR ?? path.resolve(process.cwd(), '.appdata');
  const dbPath = path.join(dataDir, 'library.sqlite');
  const cacheDir = path.join(dataDir, 'cache');

  const store = new SqliteStore(dbPath);
  const fileop = new NodeFileOpAdapter();
  const probe = new NodeMediaProbe(cacheDir);
  const core = new CoreApp({ store, fileop, probe });
  core.setEmitter((event, payload) => post({ type: 'event', event, payload }));

  parentPort.on('message', async (e: { data: CoreInboundMessage }) => {
    const msg = e.data;
    if (msg.type !== 'rpc-request') return;
    try {
      const result = await core.handle(msg.channel as IpcChannel, msg.payload as IpcRequest<IpcChannel>);
      post({ type: 'rpc-response', id: msg.id, ok: true, result });
    } catch (err) {
      post({ type: 'rpc-response', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  await core.recoverOnStartup();
  post({ type: 'event', event: 'log', payload: { level: 'info', message: 'core ready' } });
}

main().catch((err) => {
  post({ type: 'event', event: 'log', payload: { level: 'error', message: String(err) } });
});
