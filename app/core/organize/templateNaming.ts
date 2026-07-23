// ============================================================================
// 命名テンプレート (P2 §C-1 / M11)。P1 の固定規則をテンプレート方式に拡張。
// トークン: {yyyy} {MM} {dd} {HHmmss} {event} {place} {person} {original} {seq}
// - {event} 未解決時は fallback 順（event→place→date）で補う。
// - date_uncertain（EXIF 日時なし）の写真は uncertainFolder に隔離し、
//   自動で誤った年フォルダへ入れない(§C-1)。
// - 純関数。P1 の安全パイプライン(§7)は不変で、変わるのは to_path の決め方だけ。
// ============================================================================

import * as path from 'node:path';
import type { MediaItem, NamingTemplate } from '../../shared/types.js';
import { sanitizeSegment } from './naming.js';

export interface TemplateContext {
  event?: string;
  place?: string;
  person?: string;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

interface DateTokens {
  yyyy: string;
  MM: string;
  dd: string;
  HHmmss: string;
  known: boolean;
}

function dateTokens(createdAt: number | null): DateTokens {
  if (createdAt == null) return { yyyy: 'unknown', MM: '00', dd: '00', HHmmss: '000000', known: false };
  const d = new Date(createdAt);
  return {
    yyyy: String(d.getUTCFullYear()),
    MM: pad(d.getUTCMonth() + 1),
    dd: pad(d.getUTCDate()),
    HHmmss: `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`,
    known: true,
  };
}

/** {event} のフォールバック解決。 */
function resolveEvent(
  ctx: TemplateContext,
  dt: DateTokens,
  fallback: NamingTemplate['fallback'],
): string {
  for (const kind of fallback) {
    if (kind === 'event' && ctx.event) return ctx.event;
    if (kind === 'place' && ctx.place) return ctx.place;
    if (kind === 'date') return `${dt.yyyy}-${dt.MM}-${dt.dd}`;
  }
  return `${dt.yyyy}-${dt.MM}-${dt.dd}`;
}

/**
 * テンプレートから再配置先の絶対パスを算出する（連番は呼び出し側で付与）。
 */
export function computeTemplatePath(
  item: MediaItem,
  ctx: TemplateContext,
  tpl: NamingTemplate,
  targetRoot: string,
): string {
  const ext = path.extname(item.sourceRef);
  const originalBase = path.basename(item.sourceRef, ext);
  const dt = dateTokens(item.createdAt);

  // 日付不確実は隔離フォルダへ（誤った年フォルダに入れない §C-1）。
  if (item.dateUncertain || !dt.known) {
    const name = tpl.keepOriginalName ? originalBase : item.id;
    return path.join(targetRoot, sanitizeSegment(tpl.uncertainFolder), `${sanitizeSegment(name)}${ext}`);
  }

  const eventName = resolveEvent(ctx, dt, tpl.fallback);
  const tokens: Record<string, string> = {
    yyyy: dt.yyyy,
    MM: dt.MM,
    dd: dt.dd,
    HHmmss: dt.HHmmss,
    event: eventName,
    place: ctx.place ?? eventName,
    person: ctx.person ?? '',
    original: tpl.keepOriginalName ? originalBase : '',
    seq: '', // 衝突時は withSequence が付与するのでテンプレの {seq} は空に。
  };

  const raw = tpl.template.replace(/\{(\w+)\}/g, (_m, key: string) => tokens[key] ?? '');
  // パスをセグメント分割し各セグメントを sanitize。空セグメントは畳む。
  const segments = raw
    .split('/')
    .map((s) => sanitizeSegment(s.replace(/_+/g, '_').replace(/^_|_$/g, '')))
    .filter((s) => s.length > 0);

  // 末尾セグメントにファイル拡張子を付与（テンプレは拡張子を含めない前提）。
  const last = segments.pop() ?? item.id;
  const fileName = `${last}${ext}`;
  return path.join(targetRoot, ...segments, fileName);
}
