import type { OrgAggregate, OrgNode } from '../domain/types';

export type NumericOperator = 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'ne';
export type SearchSortField = 'name' | 'level' | 'headcount' | 'budget' | 'performance';
export type SearchCondition =
  | { field: 'name'; op: 'contains' | 'notContains'; value: string }
  | { field: 'level'; op: 'eq' | 'ne'; value: 1 | 2 | 3 }
  | { field: 'headcount' | 'budget' | 'performance'; op: NumericOperator; value: number };

export interface SearchSort {
  field: SearchSortField;
  direction: 'asc' | 'desc';
}

export interface SearchFilter {
  /** Groups are joined by OR; conditions inside each group are joined by AND. */
  groups: SearchCondition[][];
  sort: SearchSort | null;
  limit: number | null;
}

export interface SearchResult {
  filter: SearchFilter;
  source: 'ai' | 'local' | 'text';
  explanation: string;
}

export function emptySearchFilter(): SearchFilter {
  return { groups: [], sort: null, limit: null };
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function parseCondition(value: unknown): SearchCondition {
  if (!hasExactKeys(value, ['field', 'op', 'value']))
    throw new TypeError('Invalid search condition fields.');
  if (value.field === 'name') {
    if (
      (value.op !== 'contains' && value.op !== 'notContains') ||
      typeof value.value !== 'string' ||
      value.value.trim().length < 1 ||
      value.value.trim().length > 500
    )
      throw new TypeError('Invalid search name condition.');
    return { field: value.field, op: value.op, value: value.value.trim() };
  }
  if (value.field === 'level') {
    if (
      (value.op !== 'eq' && value.op !== 'ne') ||
      (value.value !== 1 && value.value !== 2 && value.value !== 3)
    )
      throw new TypeError('Invalid search hierarchy condition.');
    return { field: value.field, op: value.op, value: value.value };
  }
  if (
    typeof value.field !== 'string' ||
    !['headcount', 'budget', 'performance'].includes(value.field) ||
    typeof value.op !== 'string' ||
    !['lt', 'lte', 'gt', 'gte', 'eq', 'ne'].includes(value.op) ||
    typeof value.value !== 'number' ||
    !Number.isFinite(value.value) ||
    value.value < 0 ||
    value.value > Number.MAX_SAFE_INTEGER
  )
    throw new TypeError('Invalid search numeric condition.');
  return {
    field: value.field as 'headcount' | 'budget' | 'performance',
    op: value.op as NumericOperator,
    value: value.value,
  };
}

/** Validates both AI output and API responses; never accepts executable expressions. */
export function parseSearchFilter(value: unknown): SearchFilter {
  if (!hasExactKeys(value, ['groups', 'sort', 'limit']))
    throw new TypeError('Invalid search filter fields.');
  if (!Array.isArray(value.groups) || value.groups.length > 8)
    throw new TypeError('Invalid search groups.');
  const groups = Array.from(value.groups, (group: unknown) => {
    if (!Array.isArray(group) || group.length < 1 || group.length > 8)
      throw new TypeError('Invalid search group.');
    return Array.from(group, parseCondition);
  });
  let sort: SearchSort | null = null;
  if (value.sort !== null) {
    if (
      !hasExactKeys(value.sort, ['field', 'direction']) ||
      typeof value.sort.field !== 'string' ||
      !['name', 'level', 'headcount', 'budget', 'performance'].includes(value.sort.field) ||
      (value.sort.direction !== 'asc' && value.sort.direction !== 'desc')
    )
      throw new TypeError('Invalid search sort.');
    sort = { field: value.sort.field as SearchSortField, direction: value.sort.direction };
  }
  if (
    value.limit !== null &&
    (typeof value.limit !== 'number' ||
      !Number.isInteger(value.limit) ||
      value.limit < 1 ||
      value.limit > 1000)
  )
    throw new TypeError('Invalid search limit.');
  return { groups, sort, limit: value.limit };
}

function matchesNumber(op: NumericOperator, expected: number, value: number | null): boolean {
  if (value === null || !Number.isFinite(value)) return false;
  switch (op) {
    case 'lt':
      return value < expected;
    case 'lte':
      return value <= expected;
    case 'gt':
      return value > expected;
    case 'gte':
      return value >= expected;
    case 'eq':
      return value === expected;
    case 'ne':
      return value !== expected;
  }
}

const normalizedName = (name: string) => name.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');

export function matchesSearchFilter(
  filter: SearchFilter,
  nodeName: string,
  depth: number,
  aggregate: OrgAggregate,
): boolean {
  return (
    filter.groups.length === 0 ||
    filter.groups.some((group) =>
      group.every((condition) => {
        if (condition.field === 'name') {
          const contains = normalizedName(nodeName).includes(normalizedName(condition.value));
          return condition.op === 'contains' ? contains : !contains;
        }
        return matchesNumber(
          condition.op,
          condition.value,
          condition.field === 'level' ? depth : aggregate[condition.field],
        );
      }),
    )
  );
}

/** Sorting never mutates input, always puts unknown metrics last, and breaks ties by id. */
export function sortSearchNodes(
  nodes: readonly OrgNode[],
  sort: SearchSort | null,
  depths: ReadonlyMap<string, number>,
  aggregates: ReadonlyMap<string, OrgAggregate>,
): OrgNode[] {
  const valueFor = (node: OrgNode): string | number | null => {
    if (!sort) return null;
    if (sort.field === 'name') return node.name;
    return sort.field === 'level' ? depths.get(node.id)! : aggregates.get(node.id)![sort.field];
  };
  return [...nodes].sort((a, b) => {
    const aValue = valueFor(a),
      bValue = valueFor(b);
    const aUnknown = aValue === null || (typeof aValue === 'number' && !Number.isFinite(aValue));
    const bUnknown = bValue === null || (typeof bValue === 'number' && !Number.isFinite(bValue));
    if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
    const compared =
      aUnknown || bUnknown
        ? 0
        : typeof aValue === 'string'
          ? aValue.localeCompare(String(bValue), 'ru')
          : aValue - Number(bValue);
    return compared * (sort?.direction === 'desc' ? -1 : 1) || a.id.localeCompare(b.id);
  });
}

/** Select membership before applying the table's independent display sort. */
export function selectSearchNodes(
  filter: SearchFilter,
  nodes: readonly OrgNode[],
  depths: ReadonlyMap<string, number>,
  aggregates: ReadonlyMap<string, OrgAggregate>,
  level: number | null = null,
): OrgNode[] {
  const matching = nodes.filter(
    (node) =>
      (level === null || depths.get(node.id) === level) &&
      matchesSearchFilter(filter, node.name, depths.get(node.id)!, aggregates.get(node.id)!),
  );
  return sortSearchNodes(matching, filter.sort, depths, aggregates).slice(
    0,
    filter.limit ?? undefined,
  );
}
