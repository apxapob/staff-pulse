import { describe, expect, it, vi } from 'vitest';
import { getFreshOrgTree } from './data.js';
import { MAX_DEMO_EMPLOYEES } from './employees.js';
import { OrgStore } from './org-store.js';

function createStore(historySize = 128): OrgStore {
  return new OrgStore({
    instanceId: 'test-instance',
    historySize,
    now: () => new Date('2026-09-14T10:00:00.000Z'),
  });
}

describe('organisation revisions', () => {
  it('commits only changed metrics in an atomic patch with a contiguous cursor', () => {
    const store = createStore();
    const initial = store.snapshot();
    const listener = vi.fn();
    store.subscribe(listener);
    const patch = store.commit([{ id: 'technology', headcount: 5, performance: 92 }]);
    expect(patch).toEqual({
      previousCursor: 'test-instance:0',
      cursor: 'test-instance:1',
      changes: [
        {
          id: 'technology',
          headcount: 5,
          employees: expect.any(Array),
          updatedAt: '2026-09-14T10:00:00.000Z',
        },
      ],
    });
    expect(listener).toHaveBeenCalledExactlyOnceWith(patch);
    const snapshot = store.snapshot();
    expect(snapshot.nodes[0]).toMatchObject({ headcount: 5 });
    expect(snapshot.nodes[0]!.employees).toHaveLength(5);
    expect(snapshot.nodes[0]!.employees!.slice(0, 4)).toEqual(initial.nodes[0]!.employees);
    expect(patch!.changes[0]!.employees).toEqual(snapshot.nodes[0]!.employees);
    expect(snapshot.nodes.slice(1)).toEqual(initial.nodes.slice(1));
    expect(initial.nodes[0]!.headcount).toBe(4);
  });

  it('does not advance the cursor, timestamps, or subscribers for a no-op', () => {
    const store = createStore();
    const initial = store.snapshot();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.commit([{ id: 'technology', headcount: 4 }])).toBeNull();
    expect(store.commit([])).toBeNull();
    expect(store.snapshot()).toEqual(initial);
    expect(listener).not.toHaveBeenCalled();
  });

  it('updates rosters atomically with headcount through shrink, zero, and growth', () => {
    const store = createStore();
    const initial = store.snapshot().nodes[0]!.employees!;
    const listener = vi.fn((patch) => {
      expect(store.snapshot().nodes[0]!.employees).toEqual(patch.changes[0].employees);
      expect(patch.changes[0].employees).toHaveLength(patch.changes[0].headcount);
    });
    store.subscribe(listener);
    for (const count of [2, 0, 4, 6]) {
      const patch = store.commit([{ id: 'technology', headcount: count }])!;
      expect(patch.changes[0]!.employees).toHaveLength(count);
      expect(patch.changes[0]!.employees!.slice(0, Math.min(4, count))).toEqual(
        initial.slice(0, count),
      );
    }
    expect(listener).toHaveBeenCalledTimes(4);
    const replay = store.replay('test-instance:0');
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.patches.map((patch) => patch.changes[0]!.employees!.length)).toEqual([
        2, 0, 4, 6,
      ]);
    }
  });

  it('keeps employee identities out of metric-only patches and supports inputs without rosters', () => {
    const store = createStore();
    const initialEmployees = store.snapshot().nodes[0]!.employees;
    expect(store.commit([{ id: 'technology', budget: 42, performance: 85 }])!.changes[0]).toEqual({
      id: 'technology',
      budget: 42,
      performance: 85,
      updatedAt: '2026-09-14T10:00:00.000Z',
    });
    expect(store.snapshot().nodes[0]!.employees).toEqual(initialEmployees);
    const node = getFreshOrgTree()[0]!;
    delete node.employees;
    const metricOnly = new OrgStore({ nodes: [node] });
    const patch = metricOnly.commit([{ id: node.id, headcount: Number.MAX_SAFE_INTEGER }]);
    expect(patch!.changes[0]).not.toHaveProperty('employees');
    expect(metricOnly.snapshot().nodes[0]).not.toHaveProperty('employees');
  });

  it('isolates nested roster data in inputs, snapshots, and immutable patch history', () => {
    const nodes = getFreshOrgTree();
    const originalName = nodes[0]!.employees![0]!.name;
    const store = new OrgStore({ nodes, instanceId: 'isolated' });
    nodes[0]!.employees![0]!.name = 'Изменено извне';
    expect(store.snapshot().nodes[0]!.employees![0]!.name).toBe(originalName);
    const patch = store.commit([{ id: 'technology', headcount: 5 }])!;
    const snapshot = store.snapshot();
    snapshot.nodes[0]!.employees![0]!.name = 'Изменён снимок';
    expect(patch.changes[0]!.employees![0]!.name).toBe(originalName);
    expect(() => {
      patch.changes[0]!.employees![0]!.name = 'Изменена история';
    }).toThrow();
    store.commit([{ id: 'technology', headcount: 1 }]);
    expect(patch.changes[0]!.employees).toHaveLength(5);
    expect(store.snapshot().nodes[0]!.employees![0]!.name).toBe(originalName);
    const replay = store.replay('isolated:0');
    expect(replay.ok && replay.patches[0]).toBe(patch);
  });

  it('rejects inconsistent initial rosters and oversized updates without committing any changes', () => {
    const nodes = getFreshOrgTree();
    nodes[0]!.headcount = 0;
    expect(() => new OrgStore({ nodes })).toThrow('Employee roster must match');
    const store = createStore();
    const initial = store.snapshot();
    expect(() =>
      store.commit([
        { id: 'frontend', budget: 1 },
        { id: 'technology', headcount: MAX_DEMO_EMPLOYEES + 1 },
      ]),
    ).toThrow('Invalid headcount');
    expect(store.snapshot()).toEqual(initial);
  });

  it('rejects generated identity collisions with custom rosters before changing state or notifying', () => {
    const nodes = getFreshOrgTree().slice(0, 2);
    nodes[1]!.employees![0]!.id = 'employee:technology:5';
    const store = new OrgStore({ nodes, instanceId: 'custom' });
    const listener = vi.fn();
    store.subscribe(listener);
    const initial = store.snapshot();
    expect(() =>
      store.commit([
        { id: 'development', budget: 1 },
        { id: 'technology', headcount: 5 },
      ]),
    ).toThrow('Duplicate employee');
    expect(store.snapshot()).toEqual(initial);
    expect(store.replay('custom:0')).toEqual({ ok: true, cursor: 'custom:0', patches: [] });
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects an invalid batch without partially applying preceding changes', () => {
    const store = createStore();
    expect(() =>
      store.commit([
        { id: 'technology', headcount: 5 },
        { id: 'frontend', performance: 101 },
      ]),
    ).toThrow('Invalid performance');
    expect(() => store.commit([{ id: 'unknown', headcount: 5 }])).toThrow(
      'Unknown organisation node',
    );
    expect(() => store.commit([{ id: 'technology', headcount: 1.5 }])).toThrow('Invalid headcount');
    expect(store.snapshot()).toEqual({ cursor: 'test-instance:0', nodes: getFreshOrgTree() });
  });

  it('replays precisely the revisions after a snapshot, including the history boundary', () => {
    const store = createStore(2);
    store.commit([{ id: 'technology', headcount: 5 }]);
    const second = store.commit([{ id: 'frontend', performance: 94 }]);
    const third = store.commit([{ id: 'backend', budget: 5_610_000 }]);
    expect(store.replay('test-instance:1')).toEqual({
      ok: true,
      cursor: 'test-instance:3',
      patches: [second, third],
    });
    expect(store.replay('test-instance:3')).toEqual({
      ok: true,
      cursor: 'test-instance:3',
      patches: [],
    });
    expect(store.replay('test-instance:0')).toEqual({ ok: false, reason: 'history-gap' });
    expect(store.replay('test-instance:4')).toEqual({ ok: false, reason: 'history-gap' });
    expect(store.replay('previous-process:3')).toEqual({ ok: false, reason: 'instance-changed' });
    expect(store.replay('garbage')).toEqual({ ok: false, reason: 'invalid-cursor' });
    expect(store.replay(undefined)).toEqual({ ok: false, reason: 'missing-cursor' });
  });

  it('unsubscribes listeners and generates repeatable bounded demo updates', () => {
    const first = createStore();
    const second = createStore();
    const listener = vi.fn();
    const unsubscribe = first.subscribe(listener);
    expect(first.subscriberCount).toBe(1);
    unsubscribe();
    expect(first.subscriberCount).toBe(0);
    for (let step = 0; step < 160; step += 1)
      expect(first.advanceDemo()).toEqual(second.advanceDemo());
    expect(listener).not.toHaveBeenCalled();
    for (const node of first.snapshot().nodes) {
      expect(node.employees).toHaveLength(node.headcount);
      expect(node.headcount).toBeGreaterThanOrEqual(0);
      expect(node.budget).toBeGreaterThanOrEqual(0);
      expect(node.performance).toBeGreaterThanOrEqual(0);
      expect(node.performance).toBeLessThanOrEqual(100);
    }
  });
});
