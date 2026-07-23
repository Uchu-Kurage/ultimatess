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

> **注記（正直に）**: 顔検出の出力デコード（`NodeMLAdapter.decodeDetections`）は
> モデルのエクスポート形式に依存します。既定は「YuNet を `[N,15]=(x,y,w,h, landmarks×10, score)`
> に後処理して出力する」一般形式を実装していますが、採用モデルに合わせて調整が必要な場合があります。
> レターボックス座標変換・IoU・NMS・L2 正規化の純ロジックは `tests/detectUtils.test.ts` で検証済みです。

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
