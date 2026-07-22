import { describe, expect, it } from 'vitest';
import { dhashFromGray, hammingDistance } from '../app/core/analysis/perceptualHash.js';
import { BKTree } from '../app/core/ann/bkTree.js';
import { BruteForceVectorIndex, cosineDistance } from '../app/core/ann/vectorIndex.js';
import { clusterFaces, type FaceVec } from '../app/core/analysis/clustering.js';
import { buildDuplicateGroups } from '../app/core/organize/dedup.js';
import type { MediaItem } from '../app/shared/types.js';

function media(id: string, phash: string, chash = `c-${id}`): MediaItem {
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
    contentHash: chash,
    perceptualHash: phash,
    thumbPath: '',
    previewPath: '',
    analysisStatus: 'done',
  };
}

describe('perceptualHash / dhash', () => {
  it('9x8 グレースケールから 64bit(16hex) を生成', () => {
    const w = 9;
    const h = 8;
    const gray = new Array(w * h).fill(0).map((_, i) => (i % w) * 10); // 左→右で増加
    const hash = dhashFromGray(gray, w, h);
    expect(hash).toHaveLength(16);
    // 各行で左<右なので left>right は常に false = 全ビット 0。
    expect(hash).toBe('0000000000000000');
  });

  it('hammingDistance は異なるビット数を返す', () => {
    expect(hammingDistance('0000', '0000')).toBe(0);
    expect(hammingDistance('0000', '000f')).toBe(4);
    expect(hammingDistance('ffff', '0000')).toBe(16);
  });
});

describe('BK-tree', () => {
  it('maxHamming 内の近傍のみ返す', () => {
    const t = new BKTree();
    t.add('a', '0000000000000000');
    t.add('b', '0000000000000001'); // 1bit 違い
    t.add('c', 'ffffffffffffffff'); // 全然違う
    const near = t.near('0000000000000000', 2).sort();
    expect(near).toEqual(['a', 'b']);
    expect(t.size()).toBe(3);
  });
});

describe('cosineDistance / VectorIndex', () => {
  it('同一ベクトルの距離は 0、直交は 1', () => {
    const a = Float32Array.from([1, 0, 0]);
    const b = Float32Array.from([0, 1, 0]);
    expect(cosineDistance(a, a)).toBeCloseTo(0, 6);
    expect(cosineDistance(a, b)).toBeCloseTo(1, 6);
  });
  it('brute force search が近い順に返す', () => {
    const idx = new BruteForceVectorIndex();
    idx.add('a', Float32Array.from([1, 0]));
    idx.add('b', Float32Array.from([0.9, 0.1]));
    idx.add('c', Float32Array.from([0, 1]));
    const res = idx.search(Float32Array.from([1, 0]), 2);
    expect(res[0].id).toBe('a');
    expect(res[1].id).toBe('b');
  });
});

describe('顔クラスタリング (ANN)', () => {
  it('近い埋め込みは同一クラスタ、遠いものは別クラスタ', () => {
    const faces: FaceVec[] = [
      { faceId: 'p1a', embedding: Float32Array.from([1, 0, 0]) },
      { faceId: 'p1b', embedding: Float32Array.from([0.98, 0.02, 0]) },
      { faceId: 'p2a', embedding: Float32Array.from([0, 1, 0]) },
      { faceId: 'p2b', embedding: Float32Array.from([0.02, 0.98, 0]) },
    ];
    const { assignments, clusterCount } = clusterFaces(
      faces,
      new BruteForceVectorIndex(),
      0.1,
    );
    expect(clusterCount).toBe(2);
    expect(assignments.get('p1a')).toBe(assignments.get('p1b'));
    expect(assignments.get('p2a')).toBe(assignments.get('p2b'));
    expect(assignments.get('p1a')).not.toBe(assignments.get('p2a'));
  });
});

describe('重複グループ化', () => {
  it('完全重複(content_hash)をまとめ、最高品質を代表に', () => {
    const m = [
      media('a', 'aaaa000000000000', 'same'),
      media('b', 'ffff000000000000', 'same'), // content 同一
      media('c', '1234567890abcdef', 'other'),
    ];
    const groups = buildDuplicateGroups({
      media: m,
      qualityOf: (id) => (id === 'b' ? 0.9 : 0.1),
    });
    expect(groups).toHaveLength(1);
    const rep = groups[0].members.find((x) => x.isRepresentative)!;
    expect(rep.mediaId).toBe('b'); // 高品質
    expect(groups[0].members).toHaveLength(2);
  });

  it('近似重複(知覚ハッシュ)をハミング距離でまとめる', () => {
    const m = [
      media('a', '0000000000000000'),
      media('b', '0000000000000003'), // 2bit 違い
      media('c', 'ffffffffffffffff'),
    ];
    const groups = buildDuplicateGroups({ media: m, maxHamming: 4 });
    expect(groups).toHaveLength(1);
    const ids = groups[0].members.map((x) => x.mediaId).sort();
    expect(ids).toEqual(['a', 'b']);
  });
});
