// ============================================================================
// LSH バンド索引 (設計書 v3 §5.4「BK-tree / LSH」)。
// 知覚ハッシュの近似重複を大規模(10万件)でも準線形に検出するための索引。
//
// 背景: BK-tree は一様乱数な高エントロピーハッシュ + 中程度の探索半径で退化し、
// クエリが全体をなめて O(n^2) 化しうる（負荷テストで判明）。
// LSH バンドはハッシュを b 個の帯に分割し「1 帯でも完全一致」を候補にする。
// b > maxHamming なら、しきい値以内の近似重複は鳩の巣原理で必ずいずれかの帯が
// 完全一致するため取りこぼさない。候補判定のハミング距離は 64bit 整数の
// popcount で計算し、文字列処理を避けて 10万規模でも高速。
// ============================================================================

import type { HashIndex } from './bkTree.js';

function popcount32(n: number): number {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  n = (n + (n >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(n, 0x01010101) >>> 24);
}

/** 16 進 16 文字(64bit)を上位/下位 32bit に分解。 */
function toNum(hash: string): { hi: number; lo: number } {
  return {
    hi: parseInt(hash.slice(0, 8), 16) >>> 0,
    lo: parseInt(hash.slice(8, 16), 16) >>> 0,
  };
}

export class LshBandIndex implements HashIndex {
  private nums = new Map<string, { hi: number; lo: number }>();
  private bands: Map<string, string[]>[];
  private bounds: number[]; // 帯の境界（16進文字インデックス）

  /**
   * @param bandCount 帯の数。maxHamming より大きくすること（既定 6 → 距離 5 まで保証）。
   * @param hashHexLen ハッシュの 16 進長（既定 16 = 64bit）。
   * 16 が bandCount で割り切れない場合は帯長を可変にして全域を覆う。
   */
  constructor(bandCount = 6, hashHexLen = 16) {
    this.bands = Array.from({ length: bandCount }, () => new Map<string, string[]>());
    this.bounds = [];
    for (let i = 0; i <= bandCount; i++) this.bounds.push(Math.floor((i * hashHexLen) / bandCount));
  }

  private bandKey(hash: string, b: number): string {
    return hash.slice(this.bounds[b], this.bounds[b + 1]);
  }

  add(id: string, hash: string): void {
    if (!hash) return;
    this.nums.set(id, toNum(hash));
    for (let b = 0; b < this.bands.length; b++) {
      const key = this.bandKey(hash, b);
      const bucket = this.bands[b].get(key);
      if (bucket) bucket.push(id);
      else this.bands[b].set(key, [id]);
    }
  }

  near(hash: string, maxHamming: number): string[] {
    if (!hash) return [];
    const q = toNum(hash);
    const seen = new Set<string>();
    const out: string[] = [];
    for (let b = 0; b < this.bands.length; b++) {
      const bucket = this.bands[b].get(this.bandKey(hash, b));
      if (!bucket) continue;
      for (let k = 0; k < bucket.length; k++) {
        const id = bucket[k];
        if (seen.has(id)) continue;
        seen.add(id);
        const n = this.nums.get(id)!;
        const dist = popcount32(q.hi ^ n.hi) + popcount32(q.lo ^ n.lo);
        if (dist <= maxHamming) out.push(id);
      }
    }
    return out;
  }

  size(): number {
    return this.nums.size;
  }
}
