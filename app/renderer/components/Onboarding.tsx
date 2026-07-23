import React, { useState } from 'react';
import { fm } from '../bridge.js';

/** 初回オンボーディング: 監視フォルダを追加して索引を開始する (M6)。 */
export function Onboarding({ onDone }: { onDone: () => void }): React.ReactElement {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async (): Promise<void> => {
    if (!path.trim()) return;
    setBusy(true);
    try {
      const root = await fm.invoke('source:addRoot', { path: path.trim() });
      await fm.invoke('index:start', { rootId: root.id });
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="onboarding">
      <h1>ようこそ</h1>
      <p>
        写真・動画が入っているフォルダを追加してください。原本はそのままの場所で読み取り、
        あなたが承認するまで一切移動・削除しません。
      </p>
      <div className="row">
        <input
          className="input"
          placeholder="/Users/you/Pictures など"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <button className="btn primary" disabled={busy} onClick={add}>
          {busy ? '追加中…' : 'フォルダを追加して索引開始'}
        </button>
      </div>
      <p className="hint">
        Apple 写真ライブラリ(.photoslibrary) や Lightroom 管理フォルダは自動で除外されます。
      </p>
    </div>
  );
}
