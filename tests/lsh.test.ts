import { describe, expect, it } from 'vitest';
import { LshBandIndex } from '../app/core/ann/lshIndex.js';

describe('LshBandIndex', () => {
  it('しきい値以内の近似重複を取りこぼさない（8帯→距離7まで保証）', () => {
    const idx = new LshBandIndex(8, 16);
    idx.add('a', '0000000000000000');
    idx.add('b', 'ffffffffffffffff'); // 全然違う
    // a と 5bit だけ違うハッシュ（末尾の複数ニブルに分散）
    const near5 = '0000000000010311'; // popcount of nibbles: 1+3+1+1 ... 距離<=7
    const res = idx.near(near5, 7);
    expect(res).toContain('a');
    expect(res).not.toContain('b');
  });

  it('距離しきい値を超えるものは返さない', () => {
    const idx = new LshBandIndex(8, 16);
    idx.add('a', '0000000000000000');
    // 1帯だけ完全一致するが実距離は大きい → 候補にはなるが hamming で除外
    const res = idx.near('00ffffffffffffff', 5);
    expect(res).not.toContain('a');
  });

  it('size を返す', () => {
    const idx = new LshBandIndex();
    idx.add('a', '0000000000000000');
    idx.add('b', '1111111111111111');
    expect(idx.size()).toBe(2);
  });
});
