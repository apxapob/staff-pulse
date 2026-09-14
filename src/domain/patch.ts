import type { OrgAggregate, OrgEmployee, OrgIndex, OrgNode, ValidationIssue } from './types';
import { employeeRostersEqual } from './employees';
import { DatasetValidationError, validateDataset } from './validation';

export type MetricField = 'headcount' | 'budget' | 'performance';

export interface MetricChange {
  readonly id: string;
  readonly headcount?: number;
  readonly budget?: number;
  readonly performance?: number;
  readonly employees?: readonly OrgEmployee[];
  readonly updatedAt: string;
}

export interface MetricPatchResult {
  readonly index: OrgIndex;
  readonly aggregates: ReadonlyMap<string, OrgAggregate>;
  /** Own metric edits and aggregate cells whose displayed value changed. */
  readonly changedFields: ReadonlyMap<string, ReadonlySet<MetricField>>;
  /** Source nodes changed by this patch, including roster-only and timestamp-only updates. */
  readonly changedIds: ReadonlySet<string>;
}

const metricFields: readonly MetricField[] = ['headcount', 'budget', 'performance'];
const allowedFields = new Set<string>(['id', 'updatedAt', 'employees', ...metricFields]);

/** Validate every entry before replacing any objects from the current snapshot. */
function validateChanges(index: OrgIndex, input: unknown): OrgNode[] {
  if (!Array.isArray(input)) {
    throw new DatasetValidationError([
      { path: '$', code: 'array', message: 'Metric changes must be a JSON array.' },
    ]);
  }

  const errors: ValidationIssue[] = [];
  const replacements: OrgNode[] = [];
  const seenIds = new Set<string>();
  const replacementRows = new Map<string, number>();
  let hasRosterUpdates = false;

  input.forEach((entry: unknown, row: number) => {
    const path = `$[${row}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push({ path, code: 'object', message: 'Each metric change must be an object.' });
      return;
    }
    const change = entry as Record<string, unknown>;
    const errorsBefore = errors.length;
    for (const field of Object.keys(change)) {
      if (!allowedFields.has(field)) {
        errors.push({
          path: `${path}.${field}`,
          code: 'object',
          message: `Metric changes cannot contain the ${field} field.`,
        });
      }
    }
    for (const field of ['id', 'updatedAt']) {
      if (!Object.hasOwn(change, field)) {
        errors.push({
          path: `${path}.${field}`,
          code: 'required',
          message: `The ${field} field is required.`,
        });
      }
    }
    if (typeof change.id !== 'string' || change.id.trim() === '') {
      errors.push({
        path: `${path}.id`,
        code: 'string',
        message: 'The id field must be a non-empty string.',
      });
      return;
    }
    if (seenIds.has(change.id)) {
      errors.push({
        path: `${path}.id`,
        code: 'duplicate',
        message: `Duplicate metric change for "${change.id}".`,
      });
    }
    seenIds.add(change.id);
    if (Object.hasOwn(change, 'employees')) hasRosterUpdates = true;

    const previous = index.nodesById.get(change.id);
    if (!previous) {
      errors.push({
        path: `${path}.id`,
        code: 'string',
        message: `Node "${change.id}" does not exist.`,
      });
      return;
    }

    // The parent is already validated in the index. Validate this row as a root
    // to reuse schema validation without traversing the unchanged hierarchy.
    const result = validateDataset([{ ...previous, ...change, parentId: null }]);
    if (!result.ok) {
      for (const issue of result.errors) {
        errors.push({ ...issue, path: issue.path.replace('$[0]', path) });
      }
      return;
    }
    if (errors.length === errorsBefore) {
      const next = { ...result.nodes[0], parentId: previous.parentId };
      if (
        previous.employees !== undefined &&
        employeeRostersEqual(previous.employees, next.employees)
      ) {
        next.employees = previous.employees;
      }
      replacements.push(next);
      replacementRows.set(next.id, row);
    }
  });

  // Check the final roster ownership, allowing an employee to move between two
  // nodes in one batch regardless of the order of those replacements.
  if (errors.length === 0 && hasRosterUpdates) {
    const employeeIds = new Set<string>();
    for (const node of index.nodesById.values()) {
      if (replacementRows.has(node.id)) continue;
      for (const employee of node.employees ?? []) employeeIds.add(employee.id);
    }
    for (const node of replacements) {
      node.employees?.forEach((employee, position) => {
        if (employeeIds.has(employee.id)) {
          errors.push({
            path: `$[${replacementRows.get(node.id)}].employees[${position}].id`,
            code: 'duplicate',
            message: `Duplicate employee ID "${employee.id}".`,
          });
        }
        employeeIds.add(employee.id);
      });
    }
  }
  if (errors.length > 0) throw new DatasetValidationError(errors);
  return replacements;
}

function addFields(
  target: Map<string, Set<MetricField>>,
  id: string,
  fields: Iterable<MetricField>,
): void {
  const existing = target.get(id) ?? new Set<MetricField>();
  for (const field of fields) existing.add(field);
  if (existing.size > 0) target.set(id, existing);
}

/**
 * Apply an ordered server batch. Only metric-changing nodes and their ancestors
 * are recalculated; structural indexes and unaffected objects remain shared.
 */
export function applyMetricChanges(
  index: OrgIndex,
  aggregates: ReadonlyMap<string, OrgAggregate>,
  changes: unknown,
): MetricPatchResult {
  const replacements = validateChanges(index, changes);
  const changedIds = new Set<string>();
  const changedFields = new Map<string, Set<MetricField>>();
  const affectedFields = new Map<string, Set<MetricField>>();
  let nodesById: Map<string, OrgNode> | undefined;

  for (const next of replacements) {
    const previous = index.nodesById.get(next.id);
    if (!previous) continue;
    const ownChanges = metricFields.filter((field) => next[field] !== previous[field]);
    if (
      ownChanges.length === 0 &&
      next.updatedAt === previous.updatedAt &&
      employeeRostersEqual(next.employees, previous.employees)
    )
      continue;

    nodesById ??= new Map(index.nodesById);
    nodesById.set(next.id, next);
    changedIds.add(next.id);
    addFields(changedFields, next.id, ownChanges);

    const recalculatedFields = new Set<MetricField>();
    if (next.headcount !== previous.headcount) {
      recalculatedFields.add('headcount');
      recalculatedFields.add('performance');
    }
    if (next.budget !== previous.budget) recalculatedFields.add('budget');
    if (next.performance * next.headcount !== previous.performance * previous.headcount) {
      recalculatedFields.add('performance');
    }

    let id: string | null = next.id;
    while (id !== null && recalculatedFields.size > 0) {
      const alreadyAffected = affectedFields.get(id);
      // This ancestor's full path was covered by an earlier changed descendant.
      if (alreadyAffected && [...recalculatedFields].every((field) => alreadyAffected.has(field)))
        break;
      addFields(affectedFields, id, recalculatedFields);
      id = index.nodesById.get(id)?.parentId ?? null;
    }
  }

  if (!nodesById) return { index, aggregates, changedIds, changedFields };

  const nextIndex: OrgIndex = { ...index, nodesById };
  let nextAggregates: Map<string, OrgAggregate> | undefined;
  const affectedIds = [...affectedFields.keys()].sort(
    (a, b) => (index.depthById.get(b) ?? 0) - (index.depthById.get(a) ?? 0),
  );

  for (const id of affectedIds) {
    const node = nodesById.get(id);
    const previous = aggregates.get(id);
    const fields = affectedFields.get(id);
    if (!node || !previous || !fields) throw new Error(`Missing indexed aggregate for "${id}".`);

    let headcount = node.headcount;
    let budget = node.budget;
    let weightedPerformance = node.performance * node.headcount;
    for (const childId of index.childrenById.get(id) ?? []) {
      const child = (nextAggregates ?? aggregates).get(childId);
      if (!child) throw new Error(`Missing indexed aggregate for "${childId}".`);
      headcount += child.headcount;
      if (fields.has('budget')) budget += child.budget;
      if (fields.has('performance'))
        weightedPerformance += (child.performance ?? 0) * child.headcount;
    }

    const next: OrgAggregate = {
      headcount: fields.has('headcount') ? headcount : previous.headcount,
      budget: fields.has('budget') ? budget : previous.budget,
      performance: fields.has('performance')
        ? headcount === 0
          ? null
          : weightedPerformance / headcount
        : previous.performance,
      nodeCount: previous.nodeCount,
    };
    const aggregateChanges = metricFields.filter((field) => next[field] !== previous[field]);
    if (aggregateChanges.length === 0) continue;
    nextAggregates ??= new Map(aggregates);
    nextAggregates.set(id, next);
    addFields(changedFields, id, aggregateChanges);
  }

  return {
    index: nextIndex,
    aggregates: nextAggregates ?? aggregates,
    changedFields,
    changedIds,
  };
}
