import React, { useState } from 'react';
import { fm } from '../bridge.js';
import { DEFAULT_NAMING_RULE, DEFAULT_TEMPLATE } from '../../shared/types.js';
import type { OrganizeProposal, RestructurePlan, SpaceReport } from '../../shared/types.js';

/** 整理レビュー画面 (M5)。提案 → プレビュー → 承認 → 実行 → Undo の動線。 */
export function Organize(): React.ReactElement {
  const [proposal, setProposal] = useState<OrganizeProposal | null>(null);
  const [plan, setPlan] = useState<RestructurePlan | null>(null);
  const [targetRoot, setTargetRoot] = useState('');
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE.template);
  const [useTemplate, setUseTemplate] = useState(false);
  const [archiveYear, setArchiveYear] = useState('');
  const [report, setReport] = useState<SpaceReport | null>(null);
  const [msg, setMsg] = useState('');

  const propose = async (kind: 'dedup' | 'junk'): Promise<void> => {
    const p =
      kind === 'dedup'
        ? await fm.invoke('organize:proposeDedup', {})
        : await fm.invoke('organize:proposeJunk', {});
    setProposal(p);
    setMsg('');
  };

  const applyProposal = async (): Promise<void> => {
    if (!proposal) return;
    await fm.invoke('organize:applyProposal', { proposalId: proposal.id });
    setMsg(`「${proposal.kind}」の対象をゴミ箱へ送りました（Undo 可能）。`);
    setProposal(null);
  };

  const previewRestructure = async (): Promise<void> => {
    if (!targetRoot.trim()) return;
    const p = useTemplate
      ? await fm.invoke('organize:proposeRestructureTemplate', {
          targetRoot: targetRoot.trim(),
          template: { ...DEFAULT_TEMPLATE, template },
        })
      : await fm.invoke('organize:proposeRestructure', {
          targetRoot: targetRoot.trim(),
          naming: DEFAULT_NAMING_RULE,
        });
    setPlan(p);
    setMsg('');
  };

  const previewArchive = async (): Promise<void> => {
    if (!targetRoot.trim() || !archiveYear.trim()) return;
    const p = await fm.invoke('organize:proposeArchive', {
      year: archiveYear.trim(),
      targetRoot: targetRoot.trim(),
    });
    setPlan(p);
    setMsg(`${archiveYear} 年の原本を外付けへアーカイブ（派生はPCに残ります）。`);
  };

  const loadReport = async (): Promise<void> => {
    setReport(await fm.invoke('organize:spaceReport', {}));
  };

  const applyRestructure = async (): Promise<void> => {
    if (!plan) return;
    await fm.invoke('organize:applyRestructure', { planId: plan.id });
    setMsg('物理再配置を開始しました（ジョブで進行・中断しても再開されます）。');
    setPlan(null);
  };

  const undo = async (ref: string): Promise<void> => {
    await fm.invoke('organize:undo', { journalRef: ref });
    setMsg('元に戻しました。');
  };

  const trashCount = proposal?.items.filter((i) => i.action === 'trash').length ?? 0;

  return (
    <div className="organize">
      <section className="card">
        <h2>重複・不要写真</h2>
        <div className="row">
          <button className="btn" onClick={() => propose('dedup')}>
            重複を検出
          </button>
          <button className="btn" onClick={() => propose('junk')}>
            不要写真を検出
          </button>
        </div>
        {proposal && (
          <div className="proposal">
            <p>
              {proposal.kind === 'dedup' ? '重複' : '不要'}候補: ゴミ箱送り {trashCount} 件 /
              合計 {proposal.items.length} 件
            </p>
            <ul className="proposal-list">
              {proposal.items.slice(0, 100).map((it) => (
                <li key={it.mediaId} className={it.action}>
                  <span className="badge">{it.action === 'trash' ? 'ゴミ箱' : '保持'}</span>
                  <code>{it.mediaId}</code>
                  {it.reason ? <span className="reason">{it.reason}</span> : null}
                </li>
              ))}
            </ul>
            <button className="btn primary" onClick={applyProposal} disabled={trashCount === 0}>
              承認してゴミ箱へ送る
            </button>
            <button className="btn ghost" onClick={() => undo(proposal.id)}>
              このセッションを Undo
            </button>
          </div>
        )}
      </section>

      <section className="card">
        <h2>物理再配置（整理整頓）</h2>
        <p className="hint">
          原本を「年 / 日付_イベント」の整った構造へ実際に移動します。プレビューで全移動計画・
          命名衝突・必要空き容量を確認してから承認してください。中断・クラッシュしても安全に再開します。
        </p>
        <div className="row">
          <input
            className="input"
            placeholder="整理先ライブラリのルート（例: /Users/you/整理済み）"
            value={targetRoot}
            onChange={(e) => setTargetRoot(e.target.value)}
          />
          <button className="btn" onClick={previewRestructure}>
            プレビュー生成
          </button>
        </div>
        <label className="chk">
          <input type="checkbox" checked={useTemplate} onChange={(e) => setUseTemplate(e.target.checked)} />
          命名テンプレートを使う
        </label>
        {useTemplate && (
          <div className="row">
            <input className="input" value={template} onChange={(e) => setTemplate(e.target.value)} />
            <span className="hint">
              トークン: {'{yyyy} {MM} {dd} {HHmmss} {event} {place} {person} {original}'}。日付不明は隔離。
            </span>
          </div>
        )}
        {plan && (
          <div className="plan">
            <div className="plan-stats">
              <div>
                <strong>{plan.items.length}</strong> 件を移動
              </div>
              <div>
                命名衝突 <strong>{plan.conflicts.length}</strong> 件（連番付与）
              </div>
              <div>
                必要空き容量 <strong>{fmtBytes(plan.spaceRequired)}</strong>
              </div>
            </div>
            <ul className="plan-list">
              {plan.items.slice(0, 50).map((it) => (
                <li key={it.mediaId}>
                  <span className={it.sameDrive ? 'tag same' : 'tag cross'}>
                    {it.sameDrive ? '同一ドライブ' : 'ドライブ跨ぎ'}
                  </span>
                  <code>{shorten(it.fromPath)}</code> → <code>{shorten(it.toPath)}</code>
                </li>
              ))}
            </ul>
            <button className="btn primary" onClick={applyRestructure}>
              承認して再配置を実行
            </button>
            <button className="btn ghost" onClick={() => undo(plan.id)}>
              実行後に元へ戻す（Undo）
            </button>
          </div>
        )}
      </section>

      <section className="card">
        <h2>外付けへアーカイブ</h2>
        <p className="hint">
          古い年の原本を外付けへ移動します。派生キャッシュはPCに残るので、外付け未接続でも
          一覧・スライドショーは通常どおり動作します。移動はP1の安全パイプラインを再利用します。
        </p>
        <div className="row">
          <input
            className="input"
            placeholder="年（例: 2019）"
            value={archiveYear}
            onChange={(e) => setArchiveYear(e.target.value)}
            style={{ maxWidth: 120 }}
          />
          <span className="hint">↑の「整理先ルート」を外付けのパスにしてください</span>
          <button className="btn" onClick={previewArchive}>
            アーカイブをプレビュー
          </button>
        </div>
      </section>

      <section className="card">
        <h2>空き容量</h2>
        <button className="btn" onClick={loadReport}>
          回収可能容量を計算
        </button>
        {report && (
          <div className="report">
            <div className="plan-stats">
              <div>
                合計 <strong>{fmtBytes(report.totalBytes)}</strong>
              </div>
              <div>
                重複 <strong>{fmtBytes(report.reclaimable.duplicates)}</strong>
              </div>
              <div>
                不要 <strong>{fmtBytes(report.reclaimable.junk)}</strong>
              </div>
              <div>
                動画プロキシ <strong>{fmtBytes(report.reclaimable.videoProxies)}</strong>
              </div>
            </div>
            <h3>年別</h3>
            <ul className="plan-list">
              {report.byYear.slice(0, 12).map((y) => (
                <li key={y.year}>
                  <span className="tag same">{y.year}</span> {y.count} 件 · {fmtBytes(y.bytes)}
                </li>
              ))}
            </ul>
            <h3>大きいファイル</h3>
            <ul className="plan-list">
              {report.largest.slice(0, 10).map((f) => (
                <li key={f.mediaId}>
                  <span className="tag cross">{fmtBytes(f.bytes)}</span> <code>{shorten(f.sourceRef)}</code>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {msg && <div className="toast">{msg}</div>}
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
}
function shorten(p: string): string {
  return p.length > 42 ? `…${p.slice(-40)}` : p;
}
