import { defineConfig } from 'vitest/config';

// コアのユニット/受け入れテストはネイティブ依存(better-sqlite3/sharp/onnx 等)を
// 使わず、InMemoryStore と一時ディレクトリ上の実 fs だけで完結するよう設計している。
// これにより §7.4 の安全な移動パイプラインのテストを CI で確実に実行できる。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 20000,
  },
});
