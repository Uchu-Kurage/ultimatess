import React, { useEffect, useState } from 'react';
import { fm } from '../bridge.js';
import type { PersonDTO } from '../../shared/types.js';

/** 人物パネル: 命名・統合・お気に入り・再クラスタ・人物別ストーリー (M10)。 */
export function Persons(): React.ReactElement {
  const [persons, setPersons] = useState<PersonDTO[]>([]);
  const [mergeFrom, setMergeFrom] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const reload = async (): Promise<void> => setPersons(await fm.invoke('persons:list', {}));
  useEffect(() => {
    void reload();
  }, []);

  const rename = async (id: string): Promise<void> => {
    const name = window.prompt('この人物の名前は？');
    if (name == null) return;
    await fm.invoke('persons:rename', { personId: id, name });
    await reload();
  };
  const favorite = async (id: string): Promise<void> => {
    await fm.invoke('persons:toggleFavorite', { personId: id });
    await reload();
  };
  const clickMerge = async (id: string): Promise<void> => {
    if (!mergeFrom) {
      setMergeFrom(id);
      setMsg('統合先の人物をクリックしてください');
      return;
    }
    if (mergeFrom === id) {
      setMergeFrom(null);
      setMsg('');
      return;
    }
    await fm.invoke('persons:merge', { fromId: mergeFrom, intoId: id });
    setMergeFrom(null);
    setMsg('統合しました');
    await reload();
  };
  const recluster = async (): Promise<void> => {
    await fm.invoke('persons:recluster', {});
    setMsg('訂正を尊重して再クラスタリングしました');
    await reload();
  };
  const buildStories = async (): Promise<void> => {
    const ids = await fm.invoke('curation:buildPersonStories', {});
    setMsg(`${ids.length} 件の人物別ストーリーを作成しました`);
  };

  return (
    <div className="persons">
      <div className="toolbar">
        <button className="btn" onClick={recluster}>
          再クラスタリング（訂正を保持）
        </button>
        <button className="btn primary" onClick={buildStories}>
          人物別ストーリーを作成
        </button>
        {mergeFrom && <span className="hint">統合元を選択中…（もう一人をクリック）</span>}
      </div>
      <div className="person-grid">
        {persons.map((p) => (
          <div key={p.id} className={mergeFrom === p.id ? 'person-card sel' : 'person-card'}>
            <div
              className="person-cover"
              style={p.coverMediaId ? {} : {}}
            >
              {p.isFavorite ? '★' : ''}
            </div>
            <div className="person-name">{p.displayName ?? '（名前未設定）'}</div>
            <div className="person-sub">{p.photoCount} 枚</div>
            <div className="person-actions">
              <button className="btn tiny" onClick={() => rename(p.id)}>
                名前
              </button>
              <button className="btn tiny" onClick={() => favorite(p.id)}>
                {p.isFavorite ? '★' : '☆'}
              </button>
              <button className="btn tiny ghost" onClick={() => clickMerge(p.id)}>
                統合
              </button>
            </div>
          </div>
        ))}
        {persons.length === 0 && (
          <p className="hint">解析が終わると、写っている人物のクラスタがここに表示されます。</p>
        )}
      </div>
      {msg && <div className="toast">{msg}</div>}
    </div>
  );
}
