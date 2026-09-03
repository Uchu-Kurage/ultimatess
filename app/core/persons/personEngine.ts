// ============================================================================
// PersonEngine (P2 §B / M10)。顔クラスタへの命名・統合・分割・除外と、
// 訂正(face_feedback)を尊重した制約付き再クラスタリングを担う。
// プライバシー: 顔埋め込み・氏名は PC 内のみ。スマホへは名前とカバーのみ(§B-6)。
// ============================================================================

import type { FaceFeedback, Person, PersonDTO } from '../../shared/types.js';
import { newId, now } from '../../shared/util.js';
import type { Store } from '../store/store.js';
import { reclusterWithConstraints, type ConstraintFace, type PersonAnchor } from '../analysis/constrainedClustering.js';

export class PersonEngine {
  constructor(private readonly store: Store) {}

  /** クラスタに対応する Person 行を用意する（解析後に呼ぶ）。 */
  syncPersonsFromClusters(): void {
    const clusters = new Set<string>();
    const coverFaceByCluster = new Map<string, string>();
    for (const f of this.store.listAllFaces()) {
      if (!f.clusterId) continue;
      clusters.add(f.clusterId);
      if (!coverFaceByCluster.has(f.clusterId)) coverFaceByCluster.set(f.clusterId, f.id);
    }
    for (const clusterId of clusters) {
      if (this.store.getPersonByCluster(clusterId)) continue;
      const person: Person = {
        id: newId('person'),
        clusterId,
        isFavorite: false,
        confirmed: false,
        personKey: clusterId,
        coverFaceId: coverFaceByCluster.get(clusterId),
      };
      this.store.upsertPerson(person);
    }
  }

  /** 人物一覧（写真枚数順）。スマホへも渡せる DTO（埋め込みは含めない）。 */
  listPersons(): PersonDTO[] {
    // 顔一覧は 1 回だけ読み、クラスタ別マップと faceId→mediaId マップを構築して使い回す。
    // 人物ごとに listAllFaces() を呼ぶと O(人物数 × 全顔数) になり大規模で RPC タイムアウトする。
    const facesByCluster = this.facesByCluster();
    const mediaIdByFace = new Map<string, string>();
    for (const arr of facesByCluster.values()) {
      for (const f of arr) mediaIdByFace.set(f.id, f.mediaId);
    }
    const out: PersonDTO[] = [];
    for (const p of this.store.listActivePersons()) {
      const faces = facesByCluster.get(p.clusterId) ?? [];
      const mediaIds = new Set(faces.map((f) => f.mediaId));
      out.push({
        id: p.id,
        displayName: p.displayName,
        coverMediaId: this.coverMediaIdFrom(p, facesByCluster, mediaIdByFace),
        isFavorite: p.isFavorite,
        photoCount: mediaIds.size,
      });
    }
    out.sort((a, b) => b.photoCount - a.photoCount);
    return out;
  }

  /** 名前未設定クラスタを写真枚数順にレビュー（§B-2）。 */
  listUnnamed(): PersonDTO[] {
    return this.listPersons().filter((p) => !p.displayName);
  }

  rename(personId: string, name: string): void {
    const p = this.store.getPerson(personId);
    if (!p) return;
    this.store.upsertPerson({ ...p, displayName: name, confirmed: true });
  }
  setCover(personId: string, faceId: string): void {
    const p = this.store.getPerson(personId);
    if (p) this.store.upsertPerson({ ...p, coverFaceId: faceId });
  }
  toggleFavorite(personId: string): void {
    const p = this.store.getPerson(personId);
    if (p) this.store.upsertPerson({ ...p, isFavorite: !p.isFavorite });
  }

  /** この顔はこの人物（must-link）。即時反映し、制約として保存。 */
  confirmFace(faceId: string, personId: string): void {
    const person = this.store.getPerson(personId);
    if (!person) return;
    this.addFeedback(faceId, personId, 'confirm');
    this.store.setFaceCluster(faceId, person.clusterId);
    if (!person.confirmed) this.store.upsertPerson({ ...person, confirmed: true });
  }

  /** これはこの人物ではない（cannot-link）。当該クラスタから外す。 */
  rejectFace(faceId: string, personId: string): void {
    const person = this.store.getPerson(personId);
    if (!person) return;
    this.addFeedback(faceId, personId, 'reject');
    const face = this.store.listAllFaces().find((f) => f.id === faceId);
    if (face && face.clusterId === person.clusterId) {
      // ひとまず新規クラスタへ退避（recluster で精緻化）。
      this.store.setFaceCluster(faceId, newId('cluster'));
    }
  }

  /** 同一人物が割れている場合の統合。 */
  mergePersons(fromId: string, intoId: string): void {
    const from = this.store.getPerson(fromId);
    const into = this.store.getPerson(intoId);
    if (!from || !into || fromId === intoId) return;
    for (const f of this.facesByCluster().get(from.clusterId) ?? []) {
      this.store.setFaceCluster(f.id, into.clusterId);
    }
    this.store.setPersonMergedInto(fromId, intoId);
    this.store.addClusterMergeLog(newId('merge'), from.clusterId, into.clusterId, now());
  }

  /**
   * 制約付き再クラスタリング(§B-3)。confirm/reject を必ず尊重するので、
   * 訂正は再クラスタ後も巻き戻らない。増分（新規顔）にも同じ経路を使う。
   */
  recluster(threshold = 0.35): void {
    const faces = this.store.listAllFaces();
    const cfaces: ConstraintFace[] = faces.map((f) => ({
      faceId: f.id,
      embedding: f.embedding,
      clusterId: f.clusterId,
    }));
    const anchors: PersonAnchor[] = this.store
      .listActivePersons()
      .map((p) => ({ personId: p.id, clusterId: p.clusterId }));
    const feedback = this.store.listFaceFeedback();

    const { assignments } = reclusterWithConstraints(cfaces, anchors, feedback, { threshold });
    for (const f of faces) {
      const next = assignments.get(f.id);
      if (next && next !== f.clusterId) this.store.setFaceCluster(f.id, next);
    }
    // 新しく出来たクラスタにも人物を用意。
    this.syncPersonsFromClusters();
  }

  // ---- helpers ----
  private addFeedback(faceId: string, personId: string, verdict: 'confirm' | 'reject'): void {
    const fb: FaceFeedback = { id: newId('fb'), faceId, personId, verdict, createdAt: now() };
    this.store.addFaceFeedback(fb);
  }

  private facesByCluster(): Map<string, { id: string; mediaId: string }[]> {
    const map = new Map<string, { id: string; mediaId: string }[]>();
    for (const f of this.store.listAllFaces()) {
      if (!f.clusterId) continue;
      const arr = map.get(f.clusterId) ?? [];
      arr.push({ id: f.id, mediaId: f.mediaId });
      map.set(f.clusterId, arr);
    }
    return map;
  }

  /** 事前構築済みマップからカバー写真を解決する（追加の DB アクセスなし）。 */
  private coverMediaIdFrom(
    p: Person,
    facesByCluster: Map<string, { id: string; mediaId: string }[]>,
    mediaIdByFace: Map<string, string>,
  ): string | undefined {
    if (p.coverFaceId) {
      const mediaId = mediaIdByFace.get(p.coverFaceId);
      if (mediaId) return mediaId;
    }
    return facesByCluster.get(p.clusterId)?.[0]?.mediaId;
  }
}
