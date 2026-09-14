import { randomUUID } from 'node:crypto';
import { getFreshOrgTree, type OrgNode } from './data.js';
import {
  copyEmployees,
  freezeEmployees,
  MAX_DEMO_EMPLOYEES,
  resizeDemoEmployees,
} from './employees.js';

type MetricKey = 'headcount' | 'budget' | 'performance';
export type MetricChange = Pick<OrgNode, 'id'> & Partial<Pick<OrgNode, MetricKey>>;
export type PatchChange = MetricChange & Pick<OrgNode, 'updatedAt' | 'employees'>;

export interface OrgPatch {
  previousCursor: string;
  cursor: string;
  changes: readonly Readonly<PatchChange>[];
}

export type ReplayResult =
  | { ok: true; cursor: string; patches: readonly OrgPatch[] }
  | { ok: false; reason: 'missing-cursor' | 'invalid-cursor' | 'instance-changed' | 'history-gap' };

export interface OrgStoreOptions {
  nodes?: OrgNode[];
  instanceId?: string;
  historySize?: number;
  now?: () => Date;
}

const METRICS: MetricKey[] = ['headcount', 'budget', 'performance'];

function copyNode(node: OrgNode): OrgNode {
  return {
    ...node,
    ...(node.employees !== undefined ? { employees: copyEmployees(node.employees) } : {}),
  };
}

function validateEmployeeRosters(nodes: readonly OrgNode[]): void {
  const employeeIds = new Set<string>();
  for (const node of nodes) {
    if (node.employees === undefined) continue;
    if (node.employees.length !== node.headcount || node.headcount > MAX_DEMO_EMPLOYEES)
      throw new Error(`Employee roster must match demo headcount: ${node.id}`);
    for (const employee of node.employees) {
      if (!employee.id.trim() || !employee.name.trim() || !employee.role.trim())
        throw new Error(`Invalid employee for node: ${node.id}`);
      if (employeeIds.has(employee.id)) throw new Error(`Duplicate employee: ${employee.id}`);
      employeeIds.add(employee.id);
    }
  }
}

/** In-memory mock data: one atomic revision per batch of actual metric changes. */
export class OrgStore {
  private readonly nodes: Map<string, OrgNode>;
  private readonly instanceId: string;
  private readonly historySize: number;
  private readonly now: () => Date;
  private readonly history: OrgPatch[] = [];
  private readonly listeners = new Set<(patch: OrgPatch) => void>();
  private sequence = 0;
  private demoTick = 0;

  constructor({
    nodes = getFreshOrgTree(),
    instanceId = randomUUID(),
    historySize = 128,
    now = () => new Date(),
  }: OrgStoreOptions = {}) {
    if (!Number.isInteger(historySize) || historySize < 1)
      throw new Error('historySize must be a positive integer');
    if (!/^[a-zA-Z0-9_-]+$/.test(instanceId))
      throw new Error('instanceId must contain only letters, digits, underscores, or hyphens');
    validateEmployeeRosters(nodes);
    this.nodes = new Map(nodes.map((node) => [node.id, copyNode(node)]));
    this.instanceId = instanceId;
    this.historySize = historySize;
    this.now = now;
  }

  get cursor(): string {
    return `${this.instanceId}:${this.sequence}`;
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  snapshot(): { cursor: string; nodes: OrgNode[] } {
    return { cursor: this.cursor, nodes: [...this.nodes.values()].map(copyNode) };
  }

  commit(changes: readonly MetricChange[]): OrgPatch | null {
    const changedIds = new Set<string>();
    const actualChanges: MetricChange[] = [];

    // Validate the entire batch before mutating anything.
    for (const change of changes) {
      const existing = this.nodes.get(change.id);
      if (!existing) throw new Error(`Unknown organisation node: ${change.id}`);
      if (changedIds.has(change.id)) throw new Error(`Duplicate change for node: ${change.id}`);
      changedIds.add(change.id);
      const actual: MetricChange = { id: change.id };
      for (const metric of METRICS) {
        const value = change[metric];
        if (value === undefined) continue;
        if (
          !Number.isFinite(value) ||
          value < 0 ||
          (metric === 'headcount' && !Number.isSafeInteger(value)) ||
          (metric === 'headcount' &&
            existing.employees !== undefined &&
            value > MAX_DEMO_EMPLOYEES) ||
          (metric === 'performance' && value > 100)
        ) {
          throw new Error(`Invalid ${metric} for node: ${change.id}`);
        }
        if (value !== existing[metric]) actual[metric] = value;
      }
      if (Object.keys(actual).length > 1) actualChanges.push(actual);
    }

    if (actualChanges.length === 0) return null;
    const updatedAt = this.now().toISOString();
    const patchChanges = actualChanges.map((change): Readonly<PatchChange> => {
      const existing = this.nodes.get(change.id)!;
      const employees =
        change.headcount !== undefined && existing.employees !== undefined
          ? freezeEmployees(resizeDemoEmployees(change.id, change.headcount, existing.employees))
          : undefined;
      return Object.freeze({
        ...change,
        updatedAt,
        ...(employees !== undefined ? { employees } : {}),
      });
    });
    if (patchChanges.some((change) => change.employees !== undefined)) {
      const byId = new Map(patchChanges.map((change) => [change.id, change]));
      validateEmployeeRosters(
        [...this.nodes.values()].map((node) => ({ ...node, ...byId.get(node.id) })),
      );
    }
    const previousCursor = this.cursor;
    this.sequence += 1;
    const patch: OrgPatch = Object.freeze({
      previousCursor,
      cursor: this.cursor,
      changes: Object.freeze(patchChanges),
    });
    for (const change of patch.changes) {
      this.nodes.set(change.id, { ...this.nodes.get(change.id)!, ...change });
    }
    this.history.push(patch);
    if (this.history.length > this.historySize) this.history.shift();
    for (const listener of this.listeners) listener(patch);
    return patch;
  }

  replay(cursor: string | undefined): ReplayResult {
    if (!cursor) return { ok: false, reason: 'missing-cursor' };
    const match = /^([^:]+):(\d+)$/.exec(cursor);
    if (!match || !Number.isSafeInteger(Number(match[2])) || String(Number(match[2])) !== match[2])
      return { ok: false, reason: 'invalid-cursor' };
    if (match[1] !== this.instanceId) return { ok: false, reason: 'instance-changed' };
    const requestedSequence = Number(match[2]);
    const oldestAvailableSequence = this.sequence - this.history.length;
    if (requestedSequence < oldestAvailableSequence || requestedSequence > this.sequence) {
      return { ok: false, reason: 'history-gap' };
    }
    return {
      ok: true,
      cursor: this.cursor,
      patches: this.history.slice(requestedSequence - oldestAvailableSequence),
    };
  }

  subscribe(listener: (patch: OrgPatch) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  advanceDemo(): OrgPatch | null {
    const nodes = [...this.nodes.values()];
    if (nodes.length === 0) return null;
    const tick = this.demoTick++;
    const node = nodes[tick % nodes.length]!;
    const metric = METRICS[tick % METRICS.length]!;
    const direction = Math.floor(tick / nodes.length) % 2 === 0 ? 1 : -1;
    let value = node[metric] + direction * (metric === 'budget' ? 10_000 : 1);
    if (metric === 'performance') value = Math.max(0, Math.min(100, value));
    else value = Math.max(0, value);
    if (metric === 'headcount' && node.employees !== undefined)
      value = Math.min(MAX_DEMO_EMPLOYEES, value);
    return this.commit([{ id: node.id, [metric]: value }]);
  }
}
