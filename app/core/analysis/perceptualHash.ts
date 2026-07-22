// ============================================================================
// 知覚ハッシュ (dhash) — 近似重複検出用。純関数なのでテスト可能。
// グレースケール画素配列から差分ハッシュを計算する。画像デコード自体は
// NodeMediaProbe(sharp) が担い、ここはビット計算のみを受け持つ。
// ============================================================================

/**
 * dhash: (w) x (h) のグレースケール（0..255）から水平方向の差分で bits を作る。
 * 標準的な 64bit ハッシュは w=9, h=8（隣接比較で 8*8=64 ビット）。
 * @returns 16 進文字列（bit 数 / 4 桁）
 */
export function dhashFromGray(gray: ArrayLike<number>, w: number, h: number): string {
  const bits: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      const left = gray[y * w + x];
      const right = gray[y * w + x + 1];
      bits.push(left > right ? 1 : 0);
    }
  }
  return bitsToHex(bits);
}

function bitsToHex(bits: number[]): string {
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    let nibble = 0;
    for (let j = 0; j < 4; j++) nibble = (nibble << 1) | (bits[i + j] ?? 0);
    hex += nibble.toString(16);
  }
  return hex;
}

/** 2 つの 16 進ハッシュのハミング距離（異なるビット数）。 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    // 長さが違えば比較不能。最大距離を返す。
    return Math.max(a.length, b.length) * 4;
  }
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}
