// ============================================================================
// Electron main (P1 §3)。ウィンドウ生成・core(utilityProcess) の起動・
// renderer↔core の IPC 中継を担う。重い処理は一切ここでは行わない。
// ============================================================================

import { app, BrowserWindow, ipcMain, utilityProcess, type UtilityProcess } from 'electron';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CoreOutboundMessage,
  IpcChannel,
  IpcRpcRequestMessage,
} from '../shared/ipc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

let win: BrowserWindow | null = null;
let core: UtilityProcess | null = null;
let rpcSeq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function startCore(): void {
  const entry = path.join(__dirname, '../core/entry.js');
  const dataDir = path.join(app.getPath('userData'), 'data');
  core = utilityProcess.fork(entry, [], {
    serviceName: 'family-memories-core',
    env: { ...process.env, FM_DATA_DIR: dataDir },
    stdio: 'inherit',
  });

  core.on('message', (msg: CoreOutboundMessage) => {
    if (msg.type === 'rpc-response') {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg.result);
      else waiter.reject(new Error(msg.error ?? 'core error'));
    } else if (msg.type === 'event') {
      win?.webContents.send('core:event', { event: msg.event, payload: msg.payload });
    }
  });
}

function callCore(channel: IpcChannel, payload: unknown): Promise<unknown> {
  if (!core) return Promise.reject(new Error('core not started'));
  const id = ++rpcSeq;
  const req: IpcRpcRequestMessage = { type: 'rpc-request', id, channel, payload };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    core!.postMessage(req);
    // 予防的タイムアウト（重処理はジョブ側で進むため RPC 自体は短時間で返す設計）。
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`core RPC timeout: ${channel}`));
      }
    }, 60000);
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  ipcMain.handle('core:invoke', (_e, { channel, payload }: { channel: IpcChannel; payload: unknown }) =>
    callCore(channel, payload),
  );
  startCore();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  core?.kill();
});
