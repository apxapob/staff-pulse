import { describe, expect, it } from 'vitest';
import { calculateAggregates } from './aggregates';
import { buildOrgIndex } from './tree';
import type { OrgNode } from './types';

const node = (
  id: string,
  parentId: string | null,
  headcount: number,
  performance: number,
  budget: number,
): OrgNode => ({
  id,
  name: id,
  parentId,
  headcount,
  performance,
  budget,
  updatedAt: '2026-09-14T12:00:00Z',
});

describe('calculateAggregates', () => {
  it('includes own metrics and all descendants using headcount-weighted performance', () => {
    const aggregates = calculateAggregates(
      buildOrgIndex([
        node('root', null, 2, 50, 100),
        node('department', 'root', 3, 60, 200),
        node('team', 'department', 5, 100, 300),
        node('sibling', 'root', 10, 20, 400),
        node('other-root', null, 1000, 100, 1000),
      ]),
    );
    expect(aggregates.get('root')).toEqual({
      headcount: 20,
      budget: 1000,
      performance: 49,
      nodeCount: 4,
    });
    expect(aggregates.get('department')).toEqual({
      headcount: 8,
      budget: 500,
      performance: 85,
      nodeCount: 2,
    });
    expect(aggregates.get('team')).toEqual({
      headcount: 5,
      budget: 300,
      performance: 100,
      nodeCount: 1,
    });
    expect(aggregates.get('other-root')?.headcount).toBe(1000);
  });

  it('does not average child averages and excludes zero-headcount performance', () => {
    const aggregates = calculateAggregates(
      buildOrgIndex([
        node('root', null, 0, 100, 100),
        node('small', 'root', 1, 10, 10),
        node('large', 'root', 9, 90, 90),
        node('empty', 'root', 0, 100, 50),
      ]),
    );
    expect(aggregates.get('root')).toEqual({
      headcount: 10,
      budget: 250,
      performance: 82,
      nodeCount: 4,
    });
    expect(aggregates.get('empty')?.performance).toBeNull();
  });

  it('returns null performance for an empty-employee subtree while still summing budgets', () => {
    const aggregates = calculateAggregates(
      buildOrgIndex([node('root', null, 0, 100, 0.1), node('child', 'root', 0, 0, 0.2)]),
    );
    expect(aggregates.get('root')).toMatchObject({ headcount: 0, performance: null, nodeCount: 2 });
    expect(aggregates.get('root')?.budget).toBeCloseTo(0.3);
  });

  it('accepts no nodes', () => {
    expect(calculateAggregates(buildOrgIndex([])).size).toBe(0);
  });

  it('aggregates a deep hierarchy without recursion', () => {
    const nodes = Array.from({ length: 15_000 }, (_, i) =>
      node(String(i), i === 0 ? null : String(i - 1), 1, 60, 2),
    );
    const aggregates = calculateAggregates(buildOrgIndex(nodes));
    expect(aggregates.get('0')).toEqual({
      headcount: 15_000,
      budget: 30_000,
      performance: 60,
      nodeCount: 15_000,
    });
  });
});
