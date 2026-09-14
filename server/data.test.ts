import { describe, expect, it } from 'vitest';
import { getFreshOrgTree, orgTreeSeed } from './data.js';

describe('organisation seed', () => {
  it('contains six rooted division trees with at least 40 nodes and three levels', () => {
    const nodes = getFreshOrgTree();
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const roots = nodes.filter((node) => node.parentId === null);
    expect(nodes.length).toBeGreaterThanOrEqual(40);
    expect(byId.size).toBe(nodes.length);
    expect(roots).toHaveLength(6);

    let maxDepth = 0;
    for (const node of nodes) {
      const ancestors = new Set([node.id]);
      let parentId = node.parentId;
      let depth = 1;
      while (parentId !== null) {
        expect(ancestors.has(parentId)).toBe(false);
        ancestors.add(parentId);
        const parent = byId.get(parentId);
        expect(parent).toBeDefined();
        parentId = parent!.parentId;
        depth += 1;
      }
      maxDepth = Math.max(maxDepth, depth);
    }

    expect(maxDepth).toBe(3);
  });

  it('provides valid own-unit metrics without including descendants', () => {
    for (const node of orgTreeSeed) {
      expect(node.headcount).toBeGreaterThan(0);
      expect(Number.isInteger(node.headcount)).toBe(true);
      expect(node.budget).toBeGreaterThan(0);
      expect(node.performance).toBeGreaterThanOrEqual(0);
      expect(node.performance).toBeLessThanOrEqual(100);
      expect(Number.isNaN(Date.parse(node.updatedAt))).toBe(false);
    }
    const development = orgTreeSeed.find((node) => node.id === 'development');
    expect(development).toMatchObject({ headcount: 3, budget: 1_200_000 });
    expect(
      orgTreeSeed
        .filter((node) => node.parentId === 'development')
        .reduce((sum, node) => sum + node.headcount, development!.headcount),
    ).toBe(40);
  });

  it('isolates mutable server state from the deterministic seed', () => {
    const first = getFreshOrgTree();
    const second = getFreshOrgTree();
    first[0]!.headcount = 0;
    first[0]!.employees![0]!.name = 'Изменённое имя';
    expect(second[0]!.headcount).toBeGreaterThan(0);
    expect(orgTreeSeed[0]!.headcount).toBe(second[0]!.headcount);
    expect(first[0]!.employees![0]!.name).not.toBe(second[0]!.employees![0]!.name);
    expect(orgTreeSeed[0]!.employees).toEqual(second[0]!.employees);
    expect(Object.isFrozen(orgTreeSeed[0]!.employees)).toBe(true);
    expect(Object.isFrozen(orgTreeSeed[0]!.employees![0])).toBe(true);
  });

  it('lists every own employee exactly once, without adding employee organisation nodes', () => {
    const ids = new Set<string>();
    for (const node of orgTreeSeed) {
      expect(node.employees).toHaveLength(node.headcount);
      for (const employee of node.employees!) {
        expect(ids.has(employee.id)).toBe(false);
        ids.add(employee.id);
        expect(employee.name).toBeTruthy();
        expect(employee.role).toBeTruthy();
        expect(employee.role).not.toBe('Специалист');
      }
    }
    expect(ids.size).toBe(orgTreeSeed.reduce((total, node) => total + node.headcount, 0));
    expect(orgTreeSeed).toHaveLength(52);
  });
});
