# ONNX モデル配置ディレクトリ

設計書 v3 §8 / P1 §8・§11 に従い、オンデバイス ML モデル（ONNX）をここへ置きます。
モデルは `MLAdapter`（`app/core/analysis/mlAdapter.ts`）越しにのみ参照され、差し替え可能です。

実モデル確定前は `MockMLAdapter`（決定論的モック）で先行実装しています。実モデルを入れる際は
`NodeMLAdapter`（onnxruntime-node）を実装し、`CoreApp` の `ml` に注入してください。

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
