import React, { useEffect, useState } from 'react';
import { fm } from './bridge.js';
import type { RootFolder } from '../shared/types.js';
import { useJobs } from './hooks.js';
import { Onboarding } from './components/Onboarding.js';
import { Library } from './components/Library.js';
import { Organize } from './components/Organize.js';
import { Stories } from './components/Stories.js';
import { JobsPanel } from './components/JobsPanel.js';
import { Settings } from './components/Settings.js';
import { JobBar } from './components/JobBar.js';

type Tab = 'stories' | 'library' | 'organize' | 'jobs' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'stories', label: '思い出' },
  { id: 'library', label: 'ライブラリ' },
  { id: 'organize', label: '整理' },
  { id: 'jobs', label: 'ジョブ' },
  { id: 'settings', label: '設定' },
];

export function App(): React.ReactElement {
  const [roots, setRoots] = useState<RootFolder[] | null>(null);
  const [tab, setTab] = useState<Tab>('stories');
  const jobs = useJobs();

  const reloadRoots = async (): Promise<void> => {
    setRoots(await fm.invoke('source:listRoots', {}));
  };
  useEffect(() => {
    void reloadRoots();
  }, []);

  if (roots === null) return <div className="loading">読み込み中…</div>;
  if (roots.length === 0) {
    return <Onboarding onDone={reloadRoots} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">📷 家族の思い出</div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={t.id === tab ? 'tab active' : 'tab'}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="content">
        {tab === 'stories' && <Stories />}
        {tab === 'library' && <Library roots={roots} />}
        {tab === 'organize' && <Organize />}
        {tab === 'jobs' && <JobsPanel />}
        {tab === 'settings' && <Settings roots={roots} onChange={reloadRoots} />}
      </main>

      <JobBar jobs={jobs} />
    </div>
  );
}
