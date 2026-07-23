// ============================================================================
// postinstall: ネイティブモジュールを Electron の ABI 向けに再ビルドする。
// Electron は独自の Node ABI を使うため、`npm install`（システム Node 向けビルド）の
// ままだと better-sqlite3 / sharp / onnxruntime-node 等が起動時に
// NODE_MODULE_VERSION 不一致で失敗する。ここで electron-rebuild を実行して解消する。
//
// 安全策:
//  - Electron が未インストール（本番 --omit=dev / CI --ignore-scripts）ならスキップ。
//  - 環境変数 SKIP_ELECTRON_REBUILD=1 でも明示スキップ可能。
// これにより通常の `npm install` は壊さず、実 PC でだけ再ビルドが走る。
// ============================================================================

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

if (process.env.SKIP_ELECTRON_REBUILD === '1') {
  console.log('[rebuild-native] SKIP_ELECTRON_REBUILD=1 のためスキップします。');
  process.exit(0);
}

// Electron が入っていなければ（CI/本番）何もしない。
try {
  require.resolve('electron');
} catch {
  console.log('[rebuild-native] electron が見つからないためスキップします（テスト/CI 環境）。');
  process.exit(0);
}

// electron-rebuild が入っていなければスキップ（--ignore-scripts 等）。
let bin;
try {
  require.resolve('@electron/rebuild');
  bin = 'electron-rebuild';
} catch {
  console.log('[rebuild-native] @electron/rebuild 未導入のためスキップします。');
  process.exit(0);
}

console.log('[rebuild-native] Electron 向けにネイティブモジュールを再ビルドします…');
const res = spawnSync(bin, ['-f'], { stdio: 'inherit', shell: process.platform === 'win32' });
// 失敗しても install 自体は失敗させない（手動 `npm run rebuild` で再試行できる）。
if (res.status !== 0) {
  console.warn('[rebuild-native] 再ビルドに失敗しました。手動で `npm run rebuild` を実行してください。');
}
process.exit(0);
