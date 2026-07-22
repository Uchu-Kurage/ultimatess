// ============================================================================
// FileOpAdapter — 安全な移動パイプラインの土台 (P1 §6 / §7)。
// OS 依存のファイル操作を抽象化する。ゴミ箱連携は差し替え可能にして、
// テストでは一時ディレクトリ上の擬似ゴミ箱を注入する。
// ============================================================================

export interface FileOpAdapter {
  /** a と b が同一ボリューム上か（同一なら rename で高速移動できる）。 */
  sameVolume(a: string, b: string): Promise<boolean>;
  /** path を含むボリュームの空き容量(バイト)。 */
  freeSpace(path: string): Promise<number>;
  /** 同一ボリュームでのアトミック move (rename)。 */
  move(from: string, to: string): Promise<void>;
  /** ドライブ跨ぎのコピー。部分ファイルを残さない（tmp→rename）。 */
  copy(from: string, to: string): Promise<void>;
  /** 内容ハッシュ（コピー整合性検証用）。 */
  checksum(path: string): Promise<string>;
  /** OS ゴミ箱へ退避（即時完全削除しない §2-2）。 */
  trash(path: string): Promise<void>;
  /** ゴミ箱からの復元（Undo 用）。トラッシュ実装が対応する場合のみ。 */
  restoreFromTrash?(originalPath: string): Promise<void>;
}
