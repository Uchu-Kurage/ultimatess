import React, { useEffect, useState } from 'react';
import { fm } from '../bridge.js';
import type { Device, PairingInfo } from '../../shared/types.js';

/** 共有（スマホ参照）パネル: サーバー起動・PIN 表示・デバイス管理 (M7)。 */
export function Sharing(): React.ReactElement {
  const [running, setRunning] = useState(false);
  const [info, setInfo] = useState<PairingInfo | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);

  const refresh = async (): Promise<void> => {
    const st = await fm.invoke('server:status', {});
    setRunning(st.running);
    setDevices(await fm.invoke('devices:list', {}));
  };
  useEffect(() => {
    void refresh();
  }, []);

  const start = async (): Promise<void> => {
    const res = await fm.invoke('server:start', {});
    setRunning(res.running);
    if (res.info) setInfo(res.info);
    await refresh();
  };
  const stop = async (): Promise<void> => {
    await fm.invoke('server:stop', {});
    setInfo(null);
    await refresh();
  };
  const newPin = async (): Promise<void> => {
    setInfo(await fm.invoke('server:generatePin', {}));
  };
  const revoke = async (id: string): Promise<void> => {
    await fm.invoke('devices:revoke', { deviceId: id });
    await refresh();
  };

  return (
    <div className="sharing">
      <section className="card">
        <h2>スマホから見る（自宅LAN内のみ）</h2>
        <p className="hint">
          サーバーは自宅LAN内にのみ公開され、外部へは出ません。スマホには派生画像だけを配信し、
          原本は送りません。スマホからの削除・整理などの操作はできません（閲覧専用）。
        </p>
        {!running ? (
          <button className="btn primary" onClick={start}>
            共有サーバーを起動
          </button>
        ) : (
          <>
            <div className="pair">
              <div className="pair-url">
                接続先: <code>{info?.url ?? '(起動中)'}</code>
              </div>
              <div className="pair-pin">
                PIN: <strong className="pin">{info?.pin ?? '------'}</strong>
              </div>
              <p className="hint">
                スマホのブラウザで接続先を開き、この PIN を入力してペアリングします。
              </p>
              <div className="row">
                <button className="btn" onClick={newPin}>
                  新しい PIN を発行
                </button>
                <button className="btn ghost" onClick={stop}>
                  サーバーを停止
                </button>
              </div>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h2>接続済みデバイス</h2>
        {devices.length === 0 && <p className="hint">まだありません。</p>}
        <ul className="device-list">
          {devices.map((d) => (
            <li key={d.id} className={d.revoked ? 'device revoked' : 'device'}>
              <div>
                <div className="device-name">{d.name}</div>
                <div className="device-sub">
                  {d.revoked ? '失効済み' : '有効'} · 最終 {new Date(d.lastSeen).toLocaleString()}
                </div>
              </div>
              {!d.revoked && (
                <button className="btn tiny ghost" onClick={() => revoke(d.id)}>
                  失効
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
