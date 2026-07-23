// ============================================================================
// M10 人物機能: 制約付き増分クラスタリング。
// 受け入れ条件(§E): ユーザーの訂正が再クラスタリング後も巻き戻らない。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../app/core/store/inMemoryStore.js';
import { PersonEngine } from '../app/core/persons/personEngine.js';
import { reclusterWithConstraints } from '../app/core/analysis/constrainedClustering.js';
import type { Face, MediaItem } from '../app/shared/types.js';
import { newId } from '../app/shared/util.js';

function vec(values: number[]): Float32Array {
  const v = Float32Array.from(values);
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

function addFace(store: InMemoryStore, clusterId: string, embedding: Float32Array): Face {
  const mediaId = newId('m');
  const m: MediaItem = {
    id: mediaId,
    rootId: 'r',
    sourceRef: `/x/${mediaId}.jpg`,
    mediaType: 'photo',
    createdAt: 0,
    dateUncertain: false,
    width: 10,
    height: 10,
    orientation: 1,
    contentHash: 'c',
    perceptualHash: '0',
    thumbPath: '',
    previewPath: '',
    analysisStatus: 'done',
  };
  store.upsertMedia(m);
  const f: Face = {
    id: newId('face'),
    mediaId,
    bbox: [0, 0, 1, 1],
    quality: 0.9,
    eyesOpen: true,
    embedding,
    clusterId,
  };
  store.insertFace(f);
  return f;
}

describe('PersonEngine: 命名と一覧', () => {
  it('クラスタから人物を作り、名前を付け、写真枚数順に並ぶ', () => {
    const store = new InMemoryStore();
    addFace(store, 'cA', vec([1, 0, 0]));
    addFace(store, 'cA', vec([0.99, 0.01, 0]));
    addFace(store, 'cB', vec([0, 1, 0]));
    const pe = new PersonEngine(store);
    pe.syncPersonsFromClusters();

    let persons = pe.listPersons();
    expect(persons).toHaveLength(2);
    expect(persons[0].photoCount).toBe(2); // cA が先頭

    const pA = store.getPersonByCluster('cA')!;
    pe.rename(pA.id, 'たろう');
    persons = pe.listPersons();
    expect(persons.find((p) => p.id === pA.id)!.displayName).toBe('たろう');
    expect(pe.listUnnamed().some((p) => p.id === pA.id)).toBe(false);
  });
});

describe('制約付きクラスタリング: 訂正が巻き戻らない', () => {
  it('confirm した顔は再クラスタ後も同じ人物に留まる', () => {
    const store = new InMemoryStore();
    // 幾何的には人物Bに近いが、ユーザーが人物Aだと confirm した顔
    const fA = addFace(store, 'cA', vec([1, 0, 0]));
    addFace(store, 'cB', vec([0, 1, 0]));
    const outlier = addFace(store, 'cB', vec([0.1, 0.99, 0])); // 幾何的にはB
    const pe = new PersonEngine(store);
    pe.syncPersonsFromClusters();
    const pA = store.getPersonByCluster('cA')!;

    // outlier を「これはAだ」と confirm。
    pe.confirmFace(outlier.id, pA.id);
    expect(store.listAllFaces().find((f) => f.id === outlier.id)!.clusterId).toBe('cA');

    // 再クラスタしても A のまま（幾何的にはBに引っ張られるが制約が勝つ）。
    pe.recluster();
    expect(store.listAllFaces().find((f) => f.id === outlier.id)!.clusterId).toBe('cA');
    // 元から A の顔も維持。
    expect(store.listAllFaces().find((f) => f.id === fA.id)!.clusterId).toBe('cA');
  });

  it('reject した顔は再クラスタ後もその人物クラスタに入らない', () => {
    const store = new InMemoryStore();
    addFace(store, 'cA', vec([1, 0, 0]));
    const intruder = addFace(store, 'cA', vec([0.99, 0.02, 0])); // 幾何的にはA
    const pe = new PersonEngine(store);
    pe.syncPersonsFromClusters();
    const pA = store.getPersonByCluster('cA')!;

    pe.rejectFace(intruder.id, pA.id);
    expect(store.listAllFaces().find((f) => f.id === intruder.id)!.clusterId).not.toBe('cA');

    pe.recluster();
    // 幾何的には A に極めて近いが、cannot-link 制約で A には入らない。
    expect(store.listAllFaces().find((f) => f.id === intruder.id)!.clusterId).not.toBe('cA');
  });
});

describe('reclusterWithConstraints（純関数）', () => {
  it('confirm=must-link / reject=cannot-link を厳守する', () => {
    const faces = [
      { faceId: 'f1', embedding: vec([1, 0, 0]), clusterId: 'cA' },
      { faceId: 'f2', embedding: vec([0, 1, 0]), clusterId: 'cB' },
      { faceId: 'f3', embedding: vec([0.95, 0.05, 0]), clusterId: 'cB' }, // 幾何はA寄り
    ];
    const persons = [
      { personId: 'pA', clusterId: 'cA' },
      { personId: 'pB', clusterId: 'cB' },
    ];
    const feedback = [
      { id: '1', faceId: 'f3', personId: 'pA', verdict: 'reject' as const, createdAt: 1 },
      { id: '2', faceId: 'f3', personId: 'pB', verdict: 'confirm' as const, createdAt: 2 },
    ];
    const { assignments } = reclusterWithConstraints(faces, persons, feedback, { threshold: 0.35 });
    expect(assignments.get('f3')).toBe('cB'); // reject A + confirm B
    expect(assignments.get('f1')).toBe('cA');
  });
});

describe('PersonEngine: 統合', () => {
  it('2つの人物を統合すると顔が統合先クラスタへ移る', () => {
    const store = new InMemoryStore();
    addFace(store, 'cA', vec([1, 0, 0]));
    const f2 = addFace(store, 'cB', vec([0.99, 0.01, 0]));
    const pe = new PersonEngine(store);
    pe.syncPersonsFromClusters();
    const pA = store.getPersonByCluster('cA')!;
    const pB = store.getPersonByCluster('cB')!;

    pe.mergePersons(pB.id, pA.id);
    expect(store.listAllFaces().find((f) => f.id === f2.id)!.clusterId).toBe('cA');
    expect(store.getPerson(pB.id)!.mergedInto).toBe(pA.id);
    expect(pe.listPersons().some((p) => p.id === pB.id)).toBe(false); // 統合先に吸収
  });
});
