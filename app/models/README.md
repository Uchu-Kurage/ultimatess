# ONNX モデル配置ディレクトリ

設計書 v3 §8 / P1 §8・§11 に従い、オンデバイス ML モデル（ONNX）をここへ置きます。
モデルは `MLAdapter`（`app/core/analysis/mlAdapter.ts`）越しにのみ参照され、差し替え可能です。

`NodeMLAdapter`（onnxruntime-node）は実装済みです。以下の手順で実モデルを有効化できます。
モデルが揃わない間は自動的に `MockMLAdapter`（決定論的モック）が使われます。

## 実モデルの有効化手順

1. 顔検出・顔埋め込みの ONNX モデルをこのディレクトリに置く（例）:
   - `face_detection_yunet.onnx`（YuNet 等）
   - `arcface_r50.onnx`（ArcFace 512d）
2. `models.json.example` を **`models.json`** にリネームし、`file` 名・`inputSize` 等を実モデルに合わせる。
3. アプリを再起動すると、`app/core/analysis/mlAdapterFactory.ts` がモデルの存在を検出して
   `NodeMLAdapter` を自動選択する（両モデルが揃わなければ Mock のまま）。

GPU 実行プロバイダ（Mac=CoreML / Win=DirectML）を試し、利用できなければ CPU にフォールバックします。

## 採用モデル（既定）と入手コマンド

**顔検出: YuNet（OpenCV Zoo・Apache-2.0）**
```bash
curl -L -o app/models/face_detection_yunet_2023mar.onnx \
  https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
```
**顔埋め込み: ArcFace（ONNX Model Zoo・512d）**
```bash
curl -L -o app/models/arcfaceresnet100-8.onnx \
  https://github.com/onnx/models/raw/main/validated/vision/body_analysis/arcface/model/arcfaceresnet100-8.onnx
```
（LFS 管理のため `raw.githubusercontent.com` ではなく `github.com/.../raw/` を使う。落としたファイルが
`version https://git-lfs...` で始まっていたらポインタなので取り直す。）

## デコード・前処理の実装状況

`NodeMLAdapter` は次の2形式に対応:
- **`format: "yunet"`（既定）**: YuNet の生 ONNX 出力（ストライド {8,16,32} の cls/obj/bbox/kps マルチ出力）を
  `decodeYuNet`（`app/core/analysis/yunet.ts`）で OpenCV `FaceDetectorYN` と同じ後処理で復元。
  入力は **stretch リサイズ + BGR**、座標は入力→元画像へ軸別スケールで戻す。
- **`format: "yunet15"`**: 後処理を焼き込んだ `[N,15]=(x,y,w,h, landmarks×10, score)` 単一出力向け（letterbox）。

埋め込みは **112×112・RGB・`(x-127.5)/128`・512d を L2 正規化**（`colorOrder`/`mean`/`std` で調整可）。
`models.json` の `format` / `strides` / `colorOrder` で採用モデルに合わせられます。

> **未検証（正直に）**: 実 ONNX・onnxruntime・sharp のネイティブ実行はこの環境では行えていません。
> デコード算術は `tests/yunet.test.ts`、前処理/後処理の純ロジックは `tests/detectUtils.test.ts` で担保済みですが、
> 実モデルを繋いだE2Eは実機で確認が必要です。精度をさらに上げるには 5 点ランドマークによる顔アライメントが有効です。

## 想定モデル（P1 §8）

| 用途 | 候補 | 備考 |
|---|---|---|
| 顔検出 | YuNet / SCRFD | 軽量・ONNX 入手可 |
| 顔埋め込み | ArcFace 系 (512d) | **配布時はライセンス要確認** |
| 品質 | ヒューリスティック中心（P1）／任意で NIMA | |
| シーン | MobileNet / Places365（任意） | P1 は任意 |

## 実行プロバイダ

`onnxruntime-node` の実行プロバイダで GPU を有効化します（Mac=CoreML / Win=DirectML）。
利用できない場合は CPU にフォールバックします。

> 注意: 顔認識モデルは非商用ライセンスの場合があります。個人/家庭利用は概ね可ですが、
> 配布形態が変わる場合は必ずライセンスを確認してください。
