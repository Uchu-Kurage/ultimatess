// ============================================================================
// 他アプリ管理下フォルダの除外 (設計書 v3 §2-3 / §7.1-3)。
// Apple 写真ライブラリ / Lightroom 配下を掴まないことを確認する。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { looksManagedByOtherApp } from '../app/core/source/sourceProvider.js';

describe('looksManagedByOtherApp', () => {
  it('Apple 写真ライブラリを検出する', () => {
    expect(looksManagedByOtherApp('/Users/me/Pictures/Photos Library.photoslibrary')).toBe(true);
    expect(
      looksManagedByOtherApp('/Users/me/Pictures/Photos Library.photoslibrary/originals/1/IMG.jpg'),
    ).toBe(true);
    expect(looksManagedByOtherApp('/Users/me/Pictures/古い.aplibrary/x.jpg')).toBe(true);
  });

  it('Lightroom 管理を検出する', () => {
    expect(looksManagedByOtherApp('/Users/me/Lightroom/Catalog.lrcat')).toBe(true);
    expect(looksManagedByOtherApp('/Users/me/Pictures/Lightroom Library/x.jpg')).toBe(true);
    expect(looksManagedByOtherApp('/data/MyCatalog.lrcat')).toBe(true);
  });

  it('通常のフォルダは対象化する（false）', () => {
    expect(looksManagedByOtherApp('/Users/me/Pictures/2024/沖縄/IMG_1234.jpg')).toBe(false);
    expect(looksManagedByOtherApp('/mnt/backup/family/photo.jpg')).toBe(false);
  });
});
