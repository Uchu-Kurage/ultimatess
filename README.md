# 家族思い出スライドショー & 写真整理アプリ（P1 / デスクトップ）

散らばった家族の写真・動画（〜10万ファイル規模）を、PC 内の AI が
**(a) 実際に整理整頓（物理再配置）** し、**(b) 美しいスライドショーとして再生** する
クロスプラットフォーム・デスクトップアプリ。すべての処理は PC 内で完結し、クラウド送信はありません。

本リポジトリは「システム構成設計書 v3」および「P1 実装計画」に基づく実装です。

## アーキテクチャ（P1 §3）

```
main (Electron)         : ライフサイクル・ウィンドウ・IPC 中継
  └ utilityProcess:core : コアエンジン（索引/解析/整理/キュレーション/演出/ジョブ）
       └ (将来) worker_threads : ML/ハッシュ/画像処理の並列ワーカープール
renderer (React + Vite) : UI。core とは型付き IPC で通信
```

重い処理は core（utilityProcess）に隔離し、renderer の UI をブロックしません。
renderer↔core は型付き IPC ラッパ（`app/shared/ipc.ts`）で、リクエスト/レスポンス＋進捗イベントを扱います。

## ディレクトリ構成

```
app/
  main/       Electron main・preload・IPC ブリッジ
  renderer/   React UI（Vite）: 思い出一覧 / 仮想化ライブラリ / 整理レビュー / プレイヤー / 設定
  core/       ヘッドレスコア
    source/     SourceProvider（ローカル/外付け・他アプリ管理下検出）
    index/      Indexer + MediaProbe（EXIF/寸法/知覚ハッシュ/サムネ）
    analysis/   MLAdapter・解析パイプライン・クラスタリング・知覚ハッシュ
    ann/        VectorIndex(HNSW/ブルートフォース) / HashIndex(BK-tree)
    organize/   Dedup / Junk / Restructure(安全移動) / Undo / 命名規則
    curation/   イベント検出・ベストショット選抜
    direction/  Ken Burns・タイムライン生成
    jobs/       JobOrchestrator（再開可能・一時停止可能）
    store/      SQLite リポジトリ + InMemoryStore（テスト用）
    fileop/     FileOpAdapter（OS ゴミ箱連携・チェックサム・ボリューム判定）
  shared/     型定義・IPC コントラクト
  models/     バンドル ONNX モデル（差し替え可能）
  migrations/ SQL DDL
tests/        受け入れ/ユニットテスト（§7.4 の安全な移動パイプライン他）
```

## 安全第一：物理再配置（設計書 v3 §3.3 / P1 §7）★最重要

取り返しのつかない家族写真を実際に動かすため、次を厳守します。

- **非破壊が既定**（`proposeRestructure` はプレビューのみ・原本を一切変更しない）
- **ドライラン／プレビュー**（全移動計画・命名衝突・必要空き容量を実行前に提示）
- **中断・クラッシュ耐性**：1 ファイル単位で状態(`restructure_item.state`)を即コミットし、
  起動時 `recoverOnStartup` で続きから再開／必要ならロールバック
- **ドライブ跨ぎは コピー→チェックサム照合→元をゴミ箱** の順（単純移動しない）
- **完全な物理的可逆性**：操作ジャーナルを逆再生し元の場所へ戻す（Undo）
- **他アプリ管理下フォルダの除外**（Apple Photos / Lightroom 等）
- **削除はゴミ箱送り**（即時完全削除なし）

この中核ロジック（`app/core/organize/restructure.ts`）は、ネイティブ依存なしで
完全にユニットテストできるよう設計されており、`tests/restructure.test.ts` が
P1 §7.4 の受け入れテスト（同一ドライブ大量 rename / ドライブ跨ぎ copy→verify→trash /
コピー途中クラッシュからの再開 / checksum 不一致で原本保全 / 命名衝突連番 /
空き容量不足で中止 / Undo）をすべて検証します。

## 開発

```bash
npm install            # 依存導入（ネイティブモジュール含む）
npm run typecheck      # 型チェック
npm test               # 全テスト（§7.4 含む）
npm run dev:renderer   # renderer 開発サーバー（Vite）
npm run build          # core/main/preload + renderer をビルド
npm start              # Electron 起動（要 build）
npm run dist           # electron-builder で Mac/Win 配布物を生成
```

> テスト・型チェックはネイティブモジュールのビルド無しでも動きます
> （`npm install --ignore-scripts` で可）。CI もこの前提で動作します。

## スケール設計（〜10万ファイル・設計書 v3 §9）

- 顔クラスタリング・重複検出は **ANN 近傍検索**で O(n²) を回避
- 初回解析は**再開可能な長時間ジョブ**（途中終了しても続きから）
- ライブラリ UI は**仮想化**（可視分のみ描画）
- サムネ/プレビューは**構造化キャッシュ**

## 実装状況（P1 マイルストーン）

- **M0** スキャフォールド（Electron/TS/Vite/React + 型付き IPC + SQLite マイグレーション）… ✅
- **M1** 取り込み・索引 + 再開可能ジョブ基盤 … ✅
- **M2** 解析（顔/品質・モック ML）+ ANN（HNSW / BK-tree）+ クラスタリング/重複 … ✅
- **M3** 整理エンジン（安全な移動パイプライン・§7.4 テスト全通過・Undo・起動時再開）… ✅
- **M4** キュレーション（イベント検出/選抜）+ 演出（Ken Burns/タイムライン）… ✅
- **M5** プレイヤー UI（仮想化一覧・全画面プレイヤー・整理レビュー）… ✅
- **M6** 設定・オンボーディング … ✅

ML は `app/models/` に実 ONNX モデル + `models.json` を置くと `NodeMLAdapter`
（onnxruntime-node / GPU 実行プロバイダ対応）が自動で有効化され、無ければ `MockMLAdapter`
（決定論的）にフォールバックします（`app/core/analysis/mlAdapterFactory.ts`）。設定手順は
`app/models/README.md` を参照。

### ネイティブモジュールの Electron 向け再ビルド

`better-sqlite3` / `sharp` / `onnxruntime-node` 等は Electron の ABI 向けに再ビルドが必要です。
`npm install` の **postinstall で `@electron/rebuild` が自動実行**されます
（`scripts/rebuild-native.mjs`）。Electron が無い CI/テスト環境や `--ignore-scripts`、
`SKIP_ELECTRON_REBUILD=1` では自動スキップされ、通常インストールを壊しません。
手動で再実行する場合は `npm run rebuild`。

## P2（スマホ参照・人物機能・整理の高度化）

P1 の安全性を一切後退させない前提で、P2 の 3 テーマを実装済み。

- **M7 サーバー基盤とペアリング** … `app/core/server/`。core 内 HTTP サーバー、PIN+長期トークン認証、
  デバイス管理・失効。未認証は拒否、書き込み系 API は非公開（閲覧専用）、LAN のみ。
- **M8 メディア配信と動画プロキシ** … 派生アセット（サムネ/プレビュー/H.264 プロキシ）のみを配信。
  **キャッシュ配下限定 + ID→パス解決**でパストラバーサルを構造的に排除。動画は HTTP Range 対応。
  H.264 プロキシ生成は再開可能ジョブ（`app/core/media/videoProxy.ts`）。
- **M9 スマホ Web UI** … `app/mobile/index.html`（自己完結）をサーバーが `/` で公開。宣言的タイムライン
  JSON をそのまま受け取り CSS で Ken Burns 再生、プリフェッチ・タップ開始・Wake Lock（HTTP は best-effort）。
- **M10 人物機能** … `app/core/persons/` + `constrainedClustering.ts`。命名・統合・分割・除外、
  `face_feedback`（confirm=must-link / reject=cannot-link）による**制約付き増分クラスタリング**。
  **訂正は再クラスタリング後も巻き戻らない**（テストで担保）。人物別ストーリー生成。
- **M11 再配置の高度化** … `templateNaming.ts`。命名テンプレート（`{yyyy}{event}{place}{person}…`）、
  fallback 順、`date_uncertain` の隔離、Before/After フォルダ差分。**§7 の安全パイプラインは不変**で、
  変わるのは to_path の決め方だけ（§7.4 を回帰テストとして維持）。
- **M12 空き容量最適化** … `spaceReport.ts`。回収可能容量（重複/不要/動画プロキシ）・年別使用量・
  大きいファイル一覧。外付けアーカイブは**P1 の安全パイプラインを再利用**し、派生キャッシュは PC に残すため
  外付け未接続でも一覧・再生が可能。

P2 の受け入れ条件（スマホ閲覧専用・LAN 内・原本非配信・訂正の永続・§7.4 維持）は
`tests/persons.test.ts` `tests/server.test.ts` `tests/templateNaming.test.ts` `tests/spaceArchive.test.ts`
および P1 回帰（`tests/restructure.test.ts` / `tests/undoScale.test.ts`）で検証しています。
