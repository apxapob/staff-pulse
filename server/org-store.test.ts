import { describe, expect, it, vi } from 'vitest';
import { getFreshOrgTree } from './data.js';
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
      changes: [{ id: 'technology', headcount: 5, updatedAt: '2026-09-14T10:00:00.000Z' }],
    });
    expect(listener).toHaveBeenCalledExactlyOnceWith(patch);
    const snapshot = store.snapshot();
    expect(snapshot.nodes[0]).toMatchObject({ headcount: 5 });
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
      expect(node.headcount).toBeGreaterThanOrEqual(0);
      expect(node.budget).toBeGreaterThanOrEqual(0);
      expect(node.performance).toBeGreaterThanOrEqual(0);
      expect(node.performance).toBeLessThanOrEqual(100);
    }
  });
});
