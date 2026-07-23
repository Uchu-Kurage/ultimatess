// ============================================================================
// M11 再配置の高度化: 命名テンプレート + date_uncertain 隔離 + Before/After 差分。
// P1 の安全パイプライン(§7)は不変で、変わるのは to_path の決め方だけ。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { computeTemplatePath } from '../app/core/organize/templateNaming.js';
import { buildFolderDiff } from '../app/core/organize/folderDiff.js';
import { DEFAULT_TEMPLATE, type MediaItem, type NamingTemplate } from '../app/shared/types.js';

function media(sourceRef: string, createdAt: number | null, uncertain = false): MediaItem {
  return {
    id: 'm1',
    rootId: 'r',
    sourceRef,
    mediaType: 'photo',
    createdAt,
    dateUncertain: uncertain,
    width: 10,
    height: 10,
    orientation: 1,
    contentHash: 'c',
    perceptualHash: '0',
    thumbPath: '',
    previewPath: '',
    analysisStatus: 'done',
  };
}

describe('命名テンプレート', () => {
  it('既定テンプレートを展開する', () => {
    const t = Date.UTC(2024, 7, 15, 9, 30, 12);
    const p = computeTemplatePath(
      media('/src/IMG_1234.jpg', t),
      { event: '沖縄旅行' },
      DEFAULT_TEMPLATE,
      '/lib',
    );
    expect(p).toBe('/lib/2024/2024-08-15_沖縄旅行/2024-08-15_093012_IMG_1234.jpg');
  });

  it('{event}未解決は fallback（place→date）で補う', () => {
    const t = Date.UTC(2024, 7, 15, 9, 30, 12);
    const withPlace = computeTemplatePath(media('/src/a.jpg', t), { place: '東京' }, DEFAULT_TEMPLATE, '/lib');
    expect(withPlace).toContain('/2024-08-15_東京/');
    const dateOnly = computeTemplatePath(media('/src/a.jpg', t), {}, DEFAULT_TEMPLATE, '/lib');
    expect(dateOnly).toContain('/2024-08-15_2024-08-15/');
  });

  it('{person} トークンを使うテンプレート', () => {
    const t = Date.UTC(2024, 1, 3, 8, 5, 6);
    const tpl: NamingTemplate = {
      template: '{person}/{yyyy}/{yyyy}-{MM}-{dd}_{original}',
      fallback: ['event', 'place', 'date'],
      uncertainFolder: '_未確定',
      keepOriginalName: true,
    };
    const p = computeTemplatePath(media('/src/pic.jpg', t), { person: 'はな' }, tpl, '/lib');
    expect(p).toBe('/lib/はな/2024/2024-02-03_pic.jpg');
  });

  it('date_uncertain の写真は隔離フォルダへ（年フォルダに入れない）', () => {
    const p = computeTemplatePath(media('/src/x.jpg', 123456, true), {}, DEFAULT_TEMPLATE, '/lib');
    expect(p).toBe('/lib/_日付未確定/x.jpg');
    // createdAt=null も隔離。
    const p2 = computeTemplatePath(media('/src/y.jpg', null), {}, DEFAULT_TEMPLATE, '/lib');
    expect(p2).toContain('/_日付未確定/');
  });
});

describe('Before/After フォルダ差分', () => {
  it('移動先からフォルダツリーと追加件数を作る', () => {
    const items = [
      { mediaId: 'a', fromPath: '/s/a.jpg', toPath: '/lib/2024/2024-08-15_沖縄/a.jpg', sameDrive: true },
      { mediaId: 'b', fromPath: '/s/b.jpg', toPath: '/lib/2024/2024-08-15_沖縄/b.jpg', sameDrive: true },
      { mediaId: 'c', fromPath: '/s/c.jpg', toPath: '/lib/2023/2023-01-01_正月/c.jpg', sameDrive: true },
    ];
    const diff = buildFolderDiff(items, '/lib');
    expect(diff.addedCount).toBe(3);
    const y2024 = diff.children.find((n) => n.path === '2024')!;
    expect(y2024.addedCount).toBe(2);
    expect(y2024.children[0].path).toBe('2024/2024-08-15_沖縄');
    expect(y2024.children[0].addedCount).toBe(2);
  });
});
