import React, { useState } from 'react';
import { fm } from '../bridge.js';
import type { RootFolder } from '../../shared/types.js';

/** 設定: 監視フォルダ管理・他アプリ管理下フラグ・再索引 (M6)。 */
export function Settings({
  roots,
  onChange,
}: {
  roots: RootFolder[];
  onChange: () => void;
}): React.ReactElement {
  const [path, setPath] = useState('');

  const addRoot = async (): Promise<void> => {
    if (!path.trim()) return;
    const root = await fm.invoke('source:addRoot', { path: path.trim() });
    await fm.invoke('index:start', { rootId: root.id });
    setPath('');
    onChange();
  };

  const toggleManaged = async (r: RootFolder): Promise<void> => {
    await fm.invoke('source:setManagedFlag', { rootId: r.id, managed: !r.managedByOtherApp });
    onChange();
  };

  const reindex = async (r: RootFolder): Promise<void> => {
    await fm.invoke('index:start', { rootId: r.id });
  };

  return (
    <div className="settings">
      <section className="card">
        <h2>監視フォルダ</h2>
        <ul className="root-list">
          {roots.map((r) => (
            <li key={r.id} className="root">
              <div>
                <div className="root-path">{r.path}</div>
                <div className="root-sub">
                  {r.isOnline ? '接続中' : 'オフライン'}
                  {r.managedByOtherApp ? ' · 他アプリ管理下（再配置除外）' : ''}
                </div>
              </div>
              <div className="root-actions">
                <button className="btn tiny" onClick={() => reindex(r)}>
                  再索引
                </button>
                <label className="chk">
                  <input
                    type="checkbox"
                    checked={r.managedByOtherApp}
                    onChange={() => toggleManaged(r)}
                  />
                  他アプリ管理下
                </label>
              </div>
            </li>
          ))}
        </ul>
        <div className="row">
          <input
            className="input"
            placeholder="フォルダパスを追加"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <button className="btn primary" onClick={addRoot}>
            追加して索引
          </button>
        </div>
      </section>

      <section className="card">
        <h2>プライバシー</h2>
        <p className="hint">
          原本・顔埋め込み・DB・派生データはすべて PC 内に保存され、クラウドへは送信されません。
          サーバー機能（P2）は自宅 LAN のみに公開されます。
        </p>
      </section>
    </div>
  );
}
