// ============================================================================
// BK-tree による知覚ハッシュ近傍検索 (設計書 v3 §5.4 / P1)。
// ハミング距離空間で maxHamming 以内の近傍を高速探索し、重複検出の O(n^2) を避ける。
// 純 JS でテスト可能。
// ============================================================================

import { hammingDistance } from '../analysis/perceptualHash.js';

export interface HashIndex {
  add(id: string, hash: string): void;
  near(hash: string, maxHamming: number): string[];
  size(): number;
}

interface Node {
  id: string;
  hash: string;
  children: Map<number, Node>;
}

export class BKTree implements HashIndex {
  private root: Node | null = null;
  private count = 0;

  add(id: string, hash: string): void {
    this.count += 1;
    if (!this.root) {
      this.root = { id, hash, children: new Map() };
      return;
    }
    let node = this.root;
    for (;;) {
      const d = hammingDistance(hash, node.hash);
      const child = node.children.get(d);
      if (!child) {
        node.children.set(d, { id, hash, children: new Map() });
        return;
      }
      node = child;
    }
  }

  near(hash: string, maxHamming: number): string[] {
    const out: string[] = [];
    if (!this.root) return out;
    const stack: Node[] = [this.root];
    while (stack.length) {
      const node = stack.pop()!;
      const d = hammingDistance(hash, node.hash);
      if (d <= maxHamming) out.push(node.id);
      // 三角不等式: [d-max, d+max] の範囲の子だけ探索。
      const lo = d - maxHamming;
      const hi = d + maxHamming;
      for (const [edge, child] of node.children) {
        if (edge >= lo && edge <= hi) stack.push(child);
      }
    }
    return out;
  }

  size(): number {
    return this.count;
  }
}
