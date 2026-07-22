// ============================================================================
// 近傍検索インデックス (設計書 v3 §5.4 / P1 §6) ★10万規模で必須。
// 顔埋め込みのベクトル近傍検索。総当たり O(n^2) を避けるための索引。
// - BruteForceVectorIndex: 純 JS。テスト・小規模・フォールバック用。
// - HnswVectorIndex: hnswlib-node ラッパ（本番・大規模）。
// ============================================================================

export interface VectorIndex {
  add(id: string, v: Float32Array): void;
  search(v: Float32Array, k: number): { id: string; distance: number }[];
  save(path: string): Promise<void>;
  load(path: string): Promise<void>;
  size(): number;
}

/** コサイン距離 = 1 - cos類似度。ArcFace 系埋め込みに適する。 */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class BruteForceVectorIndex implements VectorIndex {
  private ids: string[] = [];
  private vecs: Float32Array[] = [];

  add(id: string, v: Float32Array): void {
    this.ids.push(id);
    this.vecs.push(v);
  }

  search(v: Float32Array, k: number): { id: string; distance: number }[] {
    const scored = this.vecs.map((vec, i) => ({
      id: this.ids[i],
      distance: cosineDistance(v, vec),
    }));
    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, k);
  }

  async save(path: string): Promise<void> {
    const fs = await import('node:fs/promises');
    const data = {
      ids: this.ids,
      vecs: this.vecs.map((v) => Array.from(v)),
    };
    await fs.writeFile(path, JSON.stringify(data));
  }

  async load(path: string): Promise<void> {
    const fs = await import('node:fs/promises');
    const raw = JSON.parse(await fs.readFile(path, 'utf8')) as {
      ids: string[];
      vecs: number[][];
    };
    this.ids = raw.ids;
    this.vecs = raw.vecs.map((a) => Float32Array.from(a));
  }

  size(): number {
    return this.ids.length;
  }
}

/**
 * hnswlib-node による近似最近傍。大規模で高速。
 * 型は本番依存を避けるため any 経由で扱う（typecheck をネイティブ型に縛らない）。
 */
export class HnswVectorIndex implements VectorIndex {
  private index: any = null;
  private idMap: string[] = [];
  private dim: number;
  private capacity: number;

  constructor(dim = 512, capacity = 200000) {
    this.dim = dim;
    this.capacity = capacity;
  }

  private async ensure(): Promise<void> {
    if (this.index) return;
    const mod: any = await import('hnswlib-node');
    const HierarchicalNSW = mod.HierarchicalNSW ?? mod.default?.HierarchicalNSW;
    this.index = new HierarchicalNSW('cosine', this.dim);
    this.index.initIndex(this.capacity);
  }

  add(id: string, v: Float32Array): void {
    // 同期 API を満たすため、事前 ensure を前提とする（analyzer 側で init 済み）。
    if (!this.index) throw new Error('HnswVectorIndex.init() を先に呼んでください');
    const label = this.idMap.length;
    this.idMap.push(id);
    this.index.addPoint(Array.from(v), label);
  }

  async init(): Promise<void> {
    await this.ensure();
  }

  search(v: Float32Array, k: number): { id: string; distance: number }[] {
    if (!this.index) return [];
    const n = Math.min(k, this.idMap.length);
    if (n === 0) return [];
    const res = this.index.searchKnn(Array.from(v), n);
    const out: { id: string; distance: number }[] = [];
    for (let i = 0; i < res.neighbors.length; i++) {
      out.push({ id: this.idMap[res.neighbors[i]], distance: res.distances[i] });
    }
    return out;
  }

  async save(path: string): Promise<void> {
    if (!this.index) return;
    await this.index.writeIndex(path);
    const fs = await import('node:fs/promises');
    await fs.writeFile(`${path}.ids.json`, JSON.stringify(this.idMap));
  }

  async load(path: string): Promise<void> {
    await this.ensure();
    await this.index.readIndex(path);
    const fs = await import('node:fs/promises');
    this.idMap = JSON.parse(await fs.readFile(`${path}.ids.json`, 'utf8'));
  }

  size(): number {
    return this.idMap.length;
  }
}
