import { describe, expect, it } from 'vitest';
import { calculateAggregates } from './aggregates';
import { applyMetricChanges, type MetricChange } from './patch';
import { buildOrgIndex } from './tree';
import type { OrgAggregate, OrgEmployee, OrgNode } from './types';
import { DatasetValidationError } from './validation';

const oldTime = '2026-09-14T12:00:00Z';
const newTime = '2026-09-14T12:01:00Z';
const employee = (id: string): OrgEmployee => ({ id, name: `Employee ${id}`, role: 'Engineer' });
const node = (
  id: string,
  parentId: string | null,
  headcount = 2,
  performance = 60,
  budget = 100,
): OrgNode => ({
  id,
  name: id,
  parentId,
  headcount,
  performance,
  budget,
  updatedAt: oldTime,
});

function snapshot(
  nodes = [
    node('root', null),
    node('department', 'root'),
    node('team', 'department'),
    node('sibling', 'root'),
    node('other-root', null),
  ],
) {
  const index = buildOrgIndex(nodes);
  return { index, aggregates: calculateAggregates(index) };
}

function expectEquivalent(
  actual: ReadonlyMap<string, OrgAggregate>,
  expected: ReadonlyMap<string, OrgAggregate>,
) {
  expect(actual.size).toBe(expected.size);
  for (const [id, value] of expected) {
    expect(actual.get(id)).toMatchObject({
      headcount: value.headcount,
      nodeCount: value.nodeCount,
    });
    expect(actual.get(id)?.budget).toBeCloseTo(value.budget, 7);
    if (value.performance === null) expect(actual.get(id)?.performance).toBeNull();
    else expect(actual.get(id)?.performance).toBeCloseTo(value.performance, 10);
  }
}

describe('applyMetricChanges', () => {
  it('updates source metrics and ancestor aggregates while sharing all unaffected data', () => {
    const { index, aggregates } = snapshot();
    const result = applyMetricChanges(index, aggregates, [
      { id: 'team', headcount: 8, performance: 90, updatedAt: newTime },
    ]);

    expect(result.index.nodesById.get('team')).toMatchObject({
      headcount: 8,
      performance: 90,
      updatedAt: newTime,
    });
    expect(result.index.nodesById.get('department')).toBe(index.nodesById.get('department'));
    expect(result.index.nodesById.get('sibling')).toBe(index.nodesById.get('sibling'));
    expect(result.index.childrenById).toBe(index.childrenById);
    expect(result.index.rootIds).toBe(index.rootIds);
    expect(result.index.depthById).toBe(index.depthById);
    expect(result.index.postOrderIds).toBe(index.postOrderIds);
    expect(result.aggregates.get('sibling')).toBe(aggregates.get('sibling'));
    expect(result.aggregates.get('other-root')).toBe(aggregates.get('other-root'));
    expect(result.aggregates.get('department')).not.toBe(aggregates.get('department'));
    expect(result.aggregates.get('root')).toEqual({
      headcount: 14,
      budget: 400,
      performance: 1080 / 14,
      nodeCount: 4,
    });
    expect(result.changedIds).toEqual(new Set(['team']));
    expect(result.changedFields).toEqual(
      new Map([
        ['team', new Set(['headcount', 'performance'])],
        ['department', new Set(['headcount', 'performance'])],
        ['root', new Set(['headcount', 'performance'])],
      ]),
    );
    expect(index.nodesById.get('team')?.headcount).toBe(2);
    expect(aggregates.get('root')?.headcount).toBe(8);
    expectEquivalent(result.aggregates, calculateAggregates(result.index));
  });

  it.each([
    { changes: [] },
    { changes: [{ id: 'team', headcount: 2, budget: 100, performance: 60, updatedAt: oldTime }] },
  ])('preserves snapshot identity for a no-op $changes', ({ changes }) => {
    const { index, aggregates } = snapshot();
    const result = applyMetricChanges(index, aggregates, changes);
    expect(result.index).toBe(index);
    expect(result.aggregates).toBe(aggregates);
    expect(result.changedIds.size).toBe(0);
    expect(result.changedFields.size).toBe(0);
  });

  it('updates timestamps without recomputing aggregate objects or highlighting metric cells', () => {
    const { index, aggregates } = snapshot();
    const result = applyMetricChanges(index, aggregates, [{ id: 'team', updatedAt: newTime }]);
    expect(result.index).not.toBe(index);
    expect(result.index.nodesById.get('team')?.updatedAt).toBe(newTime);
    expect(result.aggregates).toBe(aggregates);
    expect(result.changedIds).toEqual(new Set(['team']));
    expect(result.changedFields.size).toBe(0);
  });

  it('updates employee details without recalculating aggregates or requiring a timestamp change', () => {
    const employees = [employee('a')];
    const { index, aggregates } = snapshot([{ ...node('team', null, 1), employees }]);
    const replacement = { ...employees[0], role: 'Lead engineer', extra: true };
    const result = applyMetricChanges(index, aggregates, [
      { id: 'team', employees: [replacement], updatedAt: oldTime },
    ]);
    expect(result.index.nodesById.get('team')?.employees).toEqual([
      { ...employee('a'), role: 'Lead engineer' },
    ]);
    expect(result.index.nodesById.get('team')?.employees?.[0]).not.toBe(replacement);
    expect(result.changedIds).toEqual(new Set(['team']));
    expect(result.changedFields.size).toBe(0);
    expect(result.aggregates).toBe(aggregates);
    expect(index.nodesById.get('team')?.employees).toBe(employees);
  });

  it('preserves roster references for metric changes and snapshot identity for equal rosters', () => {
    const employees = [employee('a')];
    const { index, aggregates } = snapshot([{ ...node('team', null, 1), employees }]);
    const noOp = applyMetricChanges(index, aggregates, [
      { id: 'team', employees: [employee('a')], updatedAt: oldTime },
    ]);
    expect(noOp.index).toBe(index);
    expect(noOp.changedIds.size).toBe(0);
    const result = applyMetricChanges(index, aggregates, [
      { id: 'team', budget: 120, updatedAt: newTime },
    ]);
    expect(result.index.nodesById.get('team')?.employees).toBe(employees);
  });

  it('adds an explicitly empty roster to a metric-only node without changing its aggregates', () => {
    const { index, aggregates } = snapshot([node('team', null, 0)]);
    const result = applyMetricChanges(index, aggregates, [
      { id: 'team', employees: [], updatedAt: oldTime },
    ]);
    expect(result.index.nodesById.get('team')?.employees).toEqual([]);
    expect(result.changedIds).toEqual(new Set(['team']));
    expect(result.aggregates).toBe(aggregates);
  });

  it('updates headcount with its roster atomically, including zero employees', () => {
    const initial = snapshot([
      { ...node('root', null, 0), employees: [] },
      { ...node('team', 'root', 1), employees: [employee('a')] },
    ]);
    const empty = applyMetricChanges(initial.index, initial.aggregates, [
      { id: 'team', headcount: 0, employees: [], updatedAt: newTime },
    ]);
    expect(empty.index.nodesById.get('team')?.employees).toEqual([]);
    expect(empty.aggregates.get('root')?.headcount).toBe(0);
    expect(empty.aggregates.get('root')?.performance).toBeNull();
    const populated = applyMetricChanges(empty.index, empty.aggregates, [
      { id: 'team', headcount: 2, employees: [employee('b'), employee('c')], updatedAt: newTime },
    ]);
    expect(populated.index.nodesById.get('team')?.employees).toHaveLength(2);
    expect(populated.aggregates.get('root')?.headcount).toBe(2);
    expectEquivalent(populated.aggregates, calculateAggregates(populated.index));
  });

  it.each([
    { headcount: 2 },
    { headcount: 0 },
    { employees: [] },
    { employees: null },
    { employees: [{ id: 'a', name: '', role: 'Engineer' }] },
    { employees: [employee('b')] },
    { employees: [employee('a'), employee('a')], headcount: 2 },
  ])('rejects incoherent or duplicate roster changes atomically: %j', (change) => {
    const nodes = [
      { ...node('root', null, 1), employees: [employee('a')] },
      { ...node('team', 'root', 1), employees: [employee('b')] },
    ];
    const { index, aggregates } = snapshot(nodes);
    expect(() =>
      applyMetricChanges(index, aggregates, [
        { id: 'team', budget: 125, updatedAt: newTime },
        { id: 'root', ...change, updatedAt: newTime },
      ]),
    ).toThrow(DatasetValidationError);
    expect([...index.nodesById.values()]).toEqual(nodes);
    expect(aggregates.get('team')?.budget).toBe(100);
  });

  it('allows atomic cross-node employee transfers in either batch order', () => {
    const { index, aggregates } = snapshot([
      { ...node('root', null, 1), employees: [employee('a')] },
      { ...node('team', 'root', 0), employees: [] },
    ]);
    const changes: MetricChange[] = [
      { id: 'root', headcount: 0, employees: [], updatedAt: newTime },
      { id: 'team', headcount: 1, employees: [employee('a')], updatedAt: newTime },
    ];
    for (const batch of [changes, [...changes].reverse()]) {
      const result = applyMetricChanges(index, aggregates, batch);
      expect(result.index.nodesById.get('root')?.employees).toEqual([]);
      expect(result.index.nodesById.get('team')?.employees).toEqual([employee('a')]);
      expect(result.aggregates.get('root')?.headcount).toBe(1);
      expectEquivalent(result.aggregates, calculateAggregates(result.index));
    }
  });

  it('rejects employee ID collisions between changed nodes before applying either edit', () => {
    const { index, aggregates } = snapshot([
      { ...node('root', null, 1), employees: [employee('a')] },
      { ...node('team', 'root', 1), employees: [employee('b')] },
    ]);
    expect(() =>
      applyMetricChanges(index, aggregates, [
        { id: 'root', employees: [employee('new')], updatedAt: newTime },
        { id: 'team', employees: [employee('new')], updatedAt: newTime },
      ]),
    ).toThrow(DatasetValidationError);
    expect(index.nodesById.get('root')?.employees).toEqual([employee('a')]);
    expect(index.nodesById.get('team')?.employees).toEqual([employee('b')]);
  });

  it('rejects an employee ID already owned by an unchanged node', () => {
    const { index, aggregates } = snapshot([
      { ...node('root', null, 1), employees: [employee('a')] },
      { ...node('team', 'root', 1), employees: [employee('b')] },
    ]);
    expect(() =>
      applyMetricChanges(index, aggregates, [
        { id: 'team', employees: [employee('a')], updatedAt: newTime },
      ]),
    ).toThrow(DatasetValidationError);
    expect(index.nodesById.get('team')?.employees).toEqual([employee('b')]);
  });

  it('changes only budget fields for a budget-only patch', () => {
    const { index, aggregates } = snapshot([
      node('root', null, 7, 12.123),
      node('department', 'root', 3, 13.456),
      node('team', 'department', 11, 88.123),
    ]);
    const result = applyMetricChanges(index, aggregates, [
      { id: 'team', budget: 101, updatedAt: newTime },
    ]);
    for (const [id, fields] of result.changedFields) {
      expect(fields).toEqual(new Set(['budget']));
      expect(result.aggregates.get(id)?.performance).toBe(aggregates.get(id)?.performance);
    }
    expectEquivalent(result.aggregates, calculateAggregates(result.index));
  });

  it('applies simultaneous ancestor and child edits independent of batch order', () => {
    const { index, aggregates } = snapshot();
    const changes: MetricChange[] = [
      { id: 'root', headcount: 10, performance: 13, updatedAt: newTime },
      { id: 'team', headcount: 1, performance: 99, updatedAt: newTime },
      { id: 'department', budget: 12, updatedAt: newTime },
      { id: 'sibling', budget: 33, updatedAt: newTime },
    ];
    const first = applyMetricChanges(index, aggregates, changes);
    const second = applyMetricChanges(index, aggregates, [...changes].reverse());
    expectEquivalent(first.aggregates, calculateAggregates(first.index));
    expectEquivalent(second.aggregates, first.aggregates);
    expect(first.index.rootIds).toBe(index.rootIds);
    expect([...first.index.nodesById.keys()]).toEqual([...index.nodesById.keys()]);
  });

  it('handles transitions into and out of a zero-employee subtree', () => {
    const initial = snapshot([node('root', null, 0, 10), node('team', 'root', 1, 90)]);
    const empty = applyMetricChanges(initial.index, initial.aggregates, [
      { id: 'team', headcount: 0, updatedAt: newTime },
    ]);
    expect(empty.aggregates.get('root')?.performance).toBeNull();
    expect(empty.aggregates.get('team')?.performance).toBeNull();

    const reactivated = applyMetricChanges(empty.index, empty.aggregates, [
      { id: 'team', headcount: 4, performance: 80, updatedAt: newTime },
    ]);
    expect(reactivated.aggregates.get('root')).toEqual({
      headcount: 4,
      budget: 200,
      performance: 80,
      nodeCount: 2,
    });
    expectEquivalent(reactivated.aggregates, calculateAggregates(reactivated.index));
  });

  it('preserves aggregates for zero-weight performance edits but reports the source cell', () => {
    const { index, aggregates } = snapshot([
      node('root', null, 0, 10),
      node('team', 'root', 0, 90),
    ]);
    const result = applyMetricChanges(index, aggregates, [
      { id: 'team', performance: 20, updatedAt: newTime },
    ]);
    expect(result.aggregates).toBe(aggregates);
    expect(result.changedFields).toEqual(new Map([['team', new Set(['performance'])]]));
  });

  it('retains an ancestor aggregate when batch edits cancel out its numerical changes', () => {
    const { index, aggregates } = snapshot();
    const result = applyMetricChanges(index, aggregates, [
      { id: 'team', budget: 125, updatedAt: newTime },
      { id: 'sibling', budget: 75, updatedAt: newTime },
    ]);
    expect(result.aggregates.get('root')).toBe(aggregates.get('root'));
    expect(result.changedFields.has('root')).toBe(false);
  });

  it.each(
    [
      null,
      {},
      [null],
      [{ id: 'team', headcount: 3 }],
      [{ headcount: 3, updatedAt: newTime }],
      [{ id: 'missing', headcount: 3, updatedAt: newTime }],
      [{ id: 'team', headcount: -1, updatedAt: newTime }],
      [{ id: 'team', headcount: 1.5, updatedAt: newTime }],
      [{ id: 'team', headcount: '3', updatedAt: newTime }],
      [{ id: 'team', budget: Infinity, updatedAt: newTime }],
      [{ id: 'team', performance: 101, updatedAt: newTime }],
      [{ id: 'team', performance: undefined, updatedAt: newTime }],
      [{ id: 'team', updatedAt: '2026-02-30T12:00:00Z' }],
      [{ id: 'team', parentId: 'root', updatedAt: newTime }],
      [{ id: 'team', name: 'Renamed', updatedAt: newTime }],
      [{ id: 'team', extra: true, updatedAt: newTime }],
      [
        { id: 'team', updatedAt: newTime },
        { id: 'team', headcount: 4, updatedAt: newTime },
      ],
    ].map((changes) => ({ changes })),
  )('rejects malformed or structural changes atomically: $changes', ({ changes }) => {
    const { index, aggregates } = snapshot();
    const originalNodes = [...index.nodesById];
    const originalAggregates = [...aggregates];
    expect(() => applyMetricChanges(index, aggregates, changes)).toThrow(DatasetValidationError);
    expect([...index.nodesById]).toEqual(originalNodes);
    expect([...aggregates]).toEqual(originalAggregates);
  });

  it('does not apply a valid first edit if a later entry is invalid', () => {
    const { index, aggregates } = snapshot();
    expect(() =>
      applyMetricChanges(index, aggregates, [
        { id: 'team', headcount: 20, updatedAt: newTime },
        { id: 'root', performance: -1, updatedAt: newTime },
      ]),
    ).toThrow(DatasetValidationError);
    expect(index.nodesById.get('team')?.headcount).toBe(2);
    expect(aggregates.get('root')?.headcount).toBe(8);
  });

  it('matches full recomputation across repeated deterministic random batches', () => {
    let seed = 917;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const nodes = Array.from({ length: 100 }, (_, i) =>
      node(
        String(i),
        i < 3 ? null : String(Math.floor(random() * i)),
        Math.floor(random() * 30),
        random() * 100,
        random() * 10_000,
      ),
    );
    let current = snapshot(nodes);
    for (let batch = 0; batch < 100; batch += 1) {
      const ids = new Set<string>();
      while (ids.size < 8) ids.add(String(Math.floor(random() * nodes.length)));
      const changes: MetricChange[] = [...ids].map((id) => ({
        id,
        headcount: Math.floor(random() * 30),
        performance: random() * 100,
        budget: random() * 10_000,
        updatedAt: new Date(Date.parse(newTime) + batch * 1000).toISOString(),
      }));
      const next = applyMetricChanges(current.index, current.aggregates, changes);
      expectEquivalent(next.aggregates, calculateAggregates(next.index));
      current = next;
    }
  });

  it('patches a deep hierarchy without recursive stack growth', () => {
    const nodes = Array.from({ length: 15_000 }, (_, i) =>
      node(String(i), i === 0 ? null : String(i - 1), 1, 60, 2),
    );
    const { index, aggregates } = snapshot(nodes);
    const result = applyMetricChanges(index, aggregates, [
      { id: '14999', headcount: 2, updatedAt: newTime },
    ]);
    expect(result.aggregates.get('0')).toMatchObject({
      headcount: 15_001,
      budget: 30_000,
      nodeCount: 15_000,
    });
    expect(result.aggregates.get('0')?.performance).toBeCloseTo(60, 10);
  });
});
