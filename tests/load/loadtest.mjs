// ============================================================================
// 10万件規模の負荷テスト（手動実行用・CI 対象外）。
//   node tests/load/loadtest.mjs
// 環境変数で件数を調整:
//   N=100000          … 純アルゴリズム/調整処理の件数
//   REAL_N=30000      … 実ファイル同一ドライブ rename の件数
//   CLUSTER_N=5000    … ブルートフォース ANN（本番は HNSW）の件数
//
// 目的: 設計書 v3 §9「総当たり比較を排除・O(n^2) を避ける」の裏付けを実測する。
// 事前に `npm run build:node` で dist を生成しておくこと。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { InMemoryStore } from '../../dist/core/store/inMemoryStore.js';
import { RestructureEngine } from '../../dist/core/organize/restructure.js';
import { buildDuplicateGroups } from '../../dist/core/organize/dedup.js';
import { BruteForceVectorIndex } from '../../dist/core/ann/vectorIndex.js';
import { clusterFaces } from '../../dist/core/analysis/clustering.js';
import { NodeFileOpAdapter } from '../../dist/core/fileop/nodeFileOpAdapter.js';

const N = Number(process.env.N ?? 100000);
const REAL_N = Number(process.env.REAL_N ?? 30000);
const CLUSTER_N = Number(process.env.CLUSTER_N ?? 5000);

function now() {
  return Number(process.hrtime.bigint() / 1000000n);
}
function mb() {
  return (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0);
}
function line(label, ms, extra = '') {
  console.log(`  ${label.padEnd(46)} ${String(ms).padStart(7)} ms   heap≈${mb()}MB  ${extra}`);
}
function hex64(rng) {
  let s = '';
  for (let i = 0; i < 16; i++) s += Math.floor(rng() * 16).toString(16);
  return s;
}
// 決定論 PRNG
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mkMedia(i, phash, chash) {
  return {
    id: `m${i}`,
    rootId: 'r',
    sourceRef: `/src/sub${i % 100}/IMG_${i}.jpg`,
    mediaType: 'photo',
    createdAt: Date.UTC(2020 + (i % 5), i % 12, (i % 27) + 1, i % 24, i % 60, i % 60),
    dateUncertain: false,
    width: 4000,
    height: 3000,
    orientation: 1,
    contentHash: chash,
    perceptualHash: phash,
    thumbPath: '',
    previewPath: '',
    analysisStatus: 'done',
  };
}

// ---------------------------------------------------------------------------
async function scenarioDedup() {
  console.log(`\n[A] 重複検出(LSH バンド) — ${N.toLocaleString()} 件`);
  const rng = mulberry32(12345);
  const media = [];
  // うち一部を意図的に近似重複クラスタにする。
  for (let i = 0; i < N; i++) {
    let phash;
    if (i % 500 === 0 && i > 0) {
      // 直前の写真に 1bit だけ違うハッシュ（近似重複）を作る
      const prev = media[i - 1].perceptualHash;
      const arr = prev.split('');
      arr[0] = ((parseInt(arr[0], 16) ^ 1) & 0xf).toString(16);
      phash = arr.join('');
    } else {
      phash = hex64(rng);
    }
    media.push(mkMedia(i, phash, `c${i}`));
  }
  const t0 = now();
  const groups = buildDuplicateGroups({ media, maxHamming: 5 });
  const dt = now() - t0;
  line('buildDuplicateGroups', dt, `groups=${groups.length}`);
}

// ---------------------------------------------------------------------------
// 調整処理（状態機械 + Store 更新 + ジャーナル）の 10万件スケール。
// FileOp は no-op（実 IO を除いた純粋な調整コストを測る）。
class NoopFileOp {
  async sameVolume() {
    return true;
  }
  async freeSpace() {
    return Number.MAX_SAFE_INTEGER;
  }
  async move() {}
  async copy() {}
  async checksum() {
    return 'x';
  }
  async trash() {}
}

async function scenarioPipelineCoordination() {
  console.log(`\n[B] 安全な移動パイプライン 調整処理 — ${N.toLocaleString()} 件 (同一ドライブ・no-op IO)`);
  const store = new InMemoryStore();
  const root = { id: 'r', path: '/src', isOnline: true, managedByOtherApp: false };
  store.addRoot(root);
  for (let i = 0; i < N; i++) store.upsertMedia(mkMedia(i, hex64(mulberry32(i)), `c${i}`));

  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'load-b-'));
  const engine = new RestructureEngine(store, new NoopFileOp());

  const t0 = now();
  const plan = await engine.proposeRestructure(target, {
    yearFolder: true,
    dateEventFolder: true,
    dateTimePrefix: true,
    keepOriginalName: true,
  });
  const t1 = now();
  line('proposeRestructure（プレビュー生成）', t1 - t0, `items=${plan.items.length} conflicts=${plan.conflicts.length}`);

  let lastPct = 0;
  const t2 = now();
  await engine.applyRestructure(plan.id, (d, t) => {
    const pct = Math.floor((d / t) * 10);
    if (pct !== lastPct) lastPct = pct;
  });
  const t3 = now();
  line('applyRestructure（状態機械+Store更新）', t3 - t2, `status=${store.getRestructurePlan(plan.id).status}`);

  const t4 = now();
  const page = store.listMedia(0, 200);
  const t5 = now();
  line('listMedia 仮想化1ページ取得(200件)', t5 - t4, `total=${store.countMedia()} got=${page.length}`);

  await fs.rm(target, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
async function scenarioRealFsRename() {
  console.log(`\n[C] 実ファイル 同一ドライブ rename — ${REAL_N.toLocaleString()} 件`);
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'load-c-'));
  const src = path.join(base, 'source');
  const target = path.join(base, 'library');
  await fs.mkdir(src, { recursive: true });

  const store = new InMemoryStore();
  store.addRoot({ id: 'r', path: src, isOnline: true, managedByOtherApp: false });

  const tc0 = now();
  const batch = 2000;
  for (let start = 0; start < REAL_N; start += batch) {
    const ps = [];
    for (let i = start; i < Math.min(REAL_N, start + batch); i++) {
      const dir = path.join(src, `sub${Math.floor(i / 1000)}`);
      const p = path.join(dir, `IMG_${i}.jpg`);
      ps.push(
        fs.mkdir(dir, { recursive: true }).then(() => fs.writeFile(p, `photo-${i}`)),
      );
      store.upsertMedia({
        id: `m${i}`,
        rootId: 'r',
        sourceRef: p,
        mediaType: 'photo',
        createdAt: Date.UTC(2020 + (i % 5), i % 12, (i % 27) + 1, i % 24, i % 60, i % 60),
        dateUncertain: false,
        width: 10,
        height: 10,
        orientation: 1,
        contentHash: `c${i}`,
        perceptualHash: '0000000000000000',
        thumbPath: '',
        previewPath: '',
        analysisStatus: 'done',
      });
    }
    await Promise.all(ps);
  }
  line('原本ファイル生成', now() - tc0);

  const engine = new RestructureEngine(store, new NodeFileOpAdapter());
  const tp0 = now();
  const plan = await engine.proposeRestructure(target, {
    yearFolder: true,
    dateEventFolder: true,
    dateTimePrefix: true,
    keepOriginalName: true,
  });
  line('proposeRestructure', now() - tp0, `items=${plan.items.length} sameDrive=${plan.items.every((i) => i.sameDrive)}`);

  const ta0 = now();
  let done = 0;
  await engine.applyRestructure(plan.id, (d) => (done = d));
  line('applyRestructure（実 rename）', now() - ta0, `moved=${done}`);

  // 整合性チェック（サンプル）
  let ok = 0;
  for (let i = 0; i < REAL_N; i += Math.max(1, Math.floor(REAL_N / 200))) {
    const m = store.getMedia(`m${i}`);
    if (m && m.sourceRef.startsWith(target)) ok++;
  }
  console.log(`      サンプル整合性 OK (${ok} 点抽出), plan=${store.getRestructurePlan(plan.id).status}`);

  await fs.rm(base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
async function scenarioClustering() {
  console.log(`\n[D] 顔クラスタリング(ブルートフォース) — ${CLUSTER_N.toLocaleString()} 件`);
  console.log('      ※本番は hnswlib(HNSW) を使用。ここは O(n^2) の総当たりで参考値。');
  const faces = [];
  for (let i = 0; i < CLUSTER_N; i++) {
    const rng = mulberry32(i);
    const v = new Float32Array(128);
    let norm = 0;
    for (let d = 0; d < 128; d++) {
      v[d] = rng() * 2 - 1;
      norm += v[d] * v[d];
    }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < 128; d++) v[d] /= norm;
    faces.push({ faceId: `f${i}`, embedding: v });
  }
  const t0 = now();
  const { clusterCount } = clusterFaces(faces, new BruteForceVectorIndex(), 0.3, 10);
  line('clusterFaces (brute force)', now() - t0, `clusters=${clusterCount}`);
}

async function main() {
  console.log('==================================================================');
  console.log('  10万件 負荷テスト  (Node ' + process.version + ')');
  console.log('==================================================================');
  const wall0 = now();
  await scenarioDedup();
  await scenarioPipelineCoordination();
  await scenarioRealFsRename();
  await scenarioClustering();
  console.log(`\n総所要 ${((now() - wall0) / 1000).toFixed(1)} 秒 / peak heap≈${mb()}MB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
