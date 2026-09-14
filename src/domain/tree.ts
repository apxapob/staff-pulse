import type { OrgIndex, OrgNode } from './types';

/** Builds an index in linear time while preserving imported sibling order. */
export function buildOrgIndex(nodes: readonly OrgNode[]): OrgIndex {
  const nodesById = new Map<string, OrgNode>();
  const childrenById = new Map<string, string[]>();
  const rootIds: string[] = [];

  for (const node of nodes) {
    if (nodesById.has(node.id)) throw new Error(`Duplicate node ID "${node.id}".`);
    nodesById.set(node.id, node);
    childrenById.set(node.id, []);
  }
  for (const node of nodes) {
    if (node.parentId === null) {
      rootIds.push(node.id);
    } else {
      const siblings = childrenById.get(node.parentId);
      if (!siblings) throw new Error(`Parent "${node.parentId}" does not exist.`);
      siblings.push(node.id);
    }
  }

  const depthById = new Map<string, number>();
  const preOrderIds: string[] = [];
  const stack = rootIds
    .slice()
    .reverse()
    .map((id) => ({ id, depth: 1 }));
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    depthById.set(entry.id, entry.depth);
    preOrderIds.push(entry.id);
    const children = childrenById.get(entry.id) ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const id = children[i];
      if (id !== undefined) stack.push({ id, depth: entry.depth + 1 });
    }
  }
  if (preOrderIds.length !== nodes.length) throw new Error('The hierarchy contains a cycle.');

  return {
    nodesById,
    childrenById,
    rootIds,
    depthById,
    postOrderIds: preOrderIds.reverse(),
  };
}

/** Returns nearest parent first. The node itself is not included. */
export function getAncestorIds(index: OrgIndex, id: string): string[] {
  const ancestors: string[] = [];
  let parentId = index.nodesById.get(id)?.parentId;
  while (parentId !== undefined && parentId !== null) {
    ancestors.push(parentId);
    parentId = index.nodesById.get(parentId)?.parentId;
  }
  return ancestors;
}

/** Returns descendants in stable depth-first order, excluding the node itself. */
export function getDescendantIds(index: OrgIndex, id: string): string[] {
  const descendants: string[] = [];
  const stack = [...(index.childrenById.get(id) ?? [])].reverse();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    descendants.push(current);
    const children = index.childrenById.get(current) ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const childId = children[i];
      if (childId !== undefined) stack.push(childId);
    }
  }
  return descendants;
}
