import { describe, expect, it } from 'vitest';
import { computeTargetPath, sanitizeSegment, withSequence } from '../app/core/organize/naming.js';
import { DEFAULT_NAMING_RULE, type MediaItem } from '../app/shared/types.js';

function media(sourceRef: string, createdAt: number | null): MediaItem {
  return {
    id: 'm1',
    rootId: 'r',
    sourceRef,
    mediaType: 'photo',
    createdAt,
    dateUncertain: createdAt == null,
    width: 10,
    height: 10,
    orientation: 1,
    contentHash: 'c',
    perceptualHash: '0000000000000000',
    thumbPath: '',
    previewPath: '',
    analysisStatus: 'done',
  };
}

describe('命名規則 (§5.6)', () => {
  it('年/日付_イベント/日付時刻_元名 の構造', () => {
    const t = Date.UTC(2024, 7, 15, 9, 30, 12);
    const p = computeTargetPath(
      media('/src/IMG_1234.jpg', t),
      { eventName: '沖縄旅行' },
      DEFAULT_NAMING_RULE,
      '/lib',
    );
    expect(p).toBe('/lib/2024/2024-08-15_沖縄旅行/2024-08-15_093012_IMG_1234.jpg');
  });

  it('イベント名が無ければ場所名→無ければ日付', () => {
    const t = Date.UTC(2024, 7, 15, 9, 30, 12);
    const withPlace = computeTargetPath(
      media('/src/a.jpg', t),
      { placeName: '東京' },
      DEFAULT_NAMING_RULE,
      '/lib',
    );
    expect(withPlace).toContain('/2024-08-15_東京/');
    const dateOnly = computeTargetPath(media('/src/a.jpg', t), {}, DEFAULT_NAMING_RULE, '/lib');
    expect(dateOnly).toContain('/2024-08-15_2024-08-15/');
  });

  it('日時が無い場合は unknown フォルダへ', () => {
    const p = computeTargetPath(media('/src/a.jpg', null), {}, DEFAULT_NAMING_RULE, '/lib');
    expect(p).toContain('/unknown/');
  });

  it('sanitizeSegment は危険文字を除去', () => {
    expect(sanitizeSegment('a/b:c*?"<>|')).toBe('abc');
    expect(sanitizeSegment('   ')).toBe('untitled');
  });

  it('withSequence が連番を付与', () => {
    expect(withSequence('/a/b.jpg', 0)).toBe('/a/b.jpg');
    expect(withSequence('/a/b.jpg', 2)).toBe('/a/b_2.jpg');
  });
});
