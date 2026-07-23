// ============================================================================
// Before/After フォルダツリー差分 (P2 §C-2 / M11)。
// 再配置プランの to_path 群から、生成されるフォルダ構造と各フォルダの追加件数を提示する。
// 純関数。
// ============================================================================

import * as path from 'node:path';
import type { FolderDiffNode, RestructurePlanItem } from '../../shared/types.js';

/** プランの移動先から、targetRoot 相対のフォルダツリー（追加件数付き）を作る。 */
export function buildFolderDiff(items: RestructurePlanItem[], targetRoot: string): FolderDiffNode {
  const root: FolderDiffNode = { path: '', addedCount: 0, children: [] };
  const childIndex = new Map<string, FolderDiffNode>(); // relPath -> node
  childIndex.set('', root);

  for (const it of items) {
    const rel = path.relative(targetRoot, path.dirname(it.toPath));
    const parts = rel === '' || rel === '.' ? [] : rel.split(path.sep);
    let cur = root;
    root.addedCount += 1;
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      let node = childIndex.get(acc);
      if (!node) {
        node = { path: acc, addedCount: 0, children: [] };
        childIndex.set(acc, node);
        cur.children.push(node);
      }
      node.addedCount += 1;
      cur = node;
    }
  }

  // 子を名前順に整列（表示安定化）。
  const sortRec = (n: FolderDiffNode): void => {
    n.children.sort((a, b) => a.path.localeCompare(b.path));
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root;
}
