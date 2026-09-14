import { describe, expect, it } from 'vitest';
import { buildOrgIndex, getAncestorIds, getDescendantIds } from './tree';
import type { OrgNode } from './types';

const node = (id: string, parentId: string | null = null): OrgNode => ({
  id,
  name: id,
  parentId,
  headcount: 0,
  budget: 0,
  performance: 0,
  updatedAt: '2026-09-14T12:00:00Z',
});

describe('hierarchy index', () => {
  const nodes = [
    node('team', 'department'),
    node('division'),
    node('other-root'),
    node('department', 'division'),
    node('other-department', 'division'),
  ];

  it('preserves root and sibling source order regardless of parent position', () => {
    const index = buildOrgIndex(nodes);
    expect(index.rootIds).toEqual(['division', 'other-root']);
    expect(index.childrenById.get('division')).toEqual(['department', 'other-department']);
    expect(index.childrenById.get('team')).toEqual([]);
    expect(index.depthById.get('division')).toBe(1);
    expect(index.depthById.get('department')).toBe(2);
    expect(index.depthById.get('team')).toBe(3);
    expect(index.nodesById.get('team')).toBe(nodes[0]);
  });

  it('places every child before its parent for bottom-up computations', () => {
    const index = buildOrgIndex(nodes);
    for (const current of nodes) {
      if (current.parentId === null) continue;
      expect(index.postOrderIds.indexOf(current.id)).toBeLessThan(
        index.postOrderIds.indexOf(current.parentId),
      );
    }
  });

  it('returns ancestors from the nearest parent to the root', () => {
    const index = buildOrgIndex(nodes);
    expect(getAncestorIds(index, 'team')).toEqual(['department', 'division']);
    expect(getAncestorIds(index, 'division')).toEqual([]);
    expect(getAncestorIds(index, 'missing')).toEqual([]);
  });

  it('returns descendants in stable depth-first order without the node itself', () => {
    const index = buildOrgIndex(nodes);
    expect(getDescendantIds(index, 'division')).toEqual(['department', 'team', 'other-department']);
    expect(getDescendantIds(index, 'team')).toEqual([]);
    expect(getDescendantIds(index, 'missing')).toEqual([]);
  });

  it('builds an empty hierarchy', () => {
    const index = buildOrgIndex([]);
    expect(index.rootIds).toEqual([]);
    expect(index.nodesById.size).toBe(0);
    expect(index.postOrderIds).toEqual([]);
  });

  it('fails fast when directly given an invalid graph', () => {
    expect(() => buildOrgIndex([node('a'), node('a')])).toThrow('Duplicate');
    expect(() => buildOrgIndex([node('a', 'missing')])).toThrow('does not exist');
    expect(() => buildOrgIndex([node('root'), node('a', 'b'), node('b', 'a')])).toThrow('cycle');
  });

  it('indexes and traverses a deep hierarchy iteratively', () => {
    const deepNodes = Array.from({ length: 15_000 }, (_, i) =>
      node(String(i), i === 0 ? null : String(i - 1)),
    );
    const index = buildOrgIndex(deepNodes);
    expect(index.depthById.get('14999')).toBe(15_000);
    expect(getDescendantIds(index, '0')).toHaveLength(14_999);
    expect(getAncestorIds(index, '14999')).toHaveLength(14_999);
  });
});
