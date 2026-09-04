// ============================================================================
// resetAnalysis（全解析やり直しの土台）: 索引は保持し、解析結果だけを破棄して
// 全メディアを pending に戻すことを検証。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../app/core/store/inMemoryStore.js';
import type { Face, MediaItem, Person } from '../app/shared/types.js';
import { newId } from '../app/shared/util.js';

function media(id: string): MediaItem {
  return {
    id,
    rootId: 'r',
    sourceRef: `/x/${id}.jpg`,
    mediaType: 'photo',
    createdAt: 0,
    dateUncertain: false,
    width: 10,
    height: 10,
    orientation: 1,
    contentHash: 'c' + id,
    perceptualHash: '0',
    thumbPath: `/cache/${id}.jpg`,
    previewPath: '',
    analysisStatus: 'done',
  };
}

describe('resetAnalysis', () => {
  it('索引・原本参照・サムネは保持し、解析結果を破棄して pending に戻す', () => {
    const store = new InMemoryStore();
    const m = media('m1');
    store.upsertMedia(m);
    const face: Face = {
      id: newId('face'),
      mediaId: 'm1',
      bbox: [0, 0, 1, 1],
      quality: 0.9,
      eyesOpen: true,
      embedding: new Float32Array([1, 0, 0]),
      clusterId: 'cA',
    };
    store.insertFace(face);
    store.upsertQuality('m1', { sharpness: 1, exposure: 1, composition: 1, eyesOpen: 1, composite: 1 });
    const person: Person = { id: 'p1', clusterId: 'cA', displayName: 'たろう', isFavorite: true, confirmed: true };
    store.upsertPerson(person);
    store.addFaceFeedback({ id: 'fb1', faceId: face.id, personId: 'p1', verdict: 'confirm', createdAt: 1 });

    store.resetAnalysis();

    // 索引と原本参照・サムネは残る
    const after = store.getMedia('m1')!;
    expect(after).toBeTruthy();
    expect(after.sourceRef).toBe('/x/m1.jpg');
    expect(after.thumbPath).toBe('/cache/m1.jpg');
    // 再解析対象へ
    expect(after.analysisStatus).toBe('pending');
    // 解析結果は消える
    expect(store.listAllFaces()).toHaveLength(0);
    expect(store.getQuality('m1')).toBeNull();
    expect(store.listActivePersons()).toHaveLength(0);
    expect(store.listFaceFeedback()).toHaveLength(0);
    // 次回の再解析対象として拾える
    expect(store.listMediaByStatus('pending')).toHaveLength(1);
  });
});
