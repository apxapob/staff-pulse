import { describe, expect, it } from 'vitest';
import type { OrgAggregate, OrgNode } from '../domain/types';
import {
  emptySearchFilter,
  matchesSearchFilter,
  parseSearchFilter,
  selectSearchNodes,
  sortSearchNodes,
  type NumericOperator,
  type SearchCondition,
  type SearchFilter,
} from './filter';

const aggregate = { headcount: 12, budget: 5_000_000, performance: 80, nodeCount: 4 };
const condition: SearchCondition = { field: 'headcount', op: 'gt', value: 10 };
const withConditions = (...conditions: SearchCondition[]): SearchFilter => ({
  ...emptySearchFilter(),
  groups: [conditions],
});

describe('parseSearchFilter', () => {
  it('validates and deeply copies OR groups, range bounds, sorting and limit', () => {
    const input = {
      groups: [
        [
          { field: 'name', op: 'notContains', value: '  разработка  ' },
          { field: 'budget', op: 'gte', value: 5_000_000 },
          { field: 'budget', op: 'lte', value: 8_000_000 },
        ],
        [{ field: 'level', op: 'ne', value: 3 }],
      ],
      sort: { field: 'budget', direction: 'desc' },
      limit: 3,
    };
    const parsed = parseSearchFilter(input);
    expect(parsed).toEqual({
      ...input,
      groups: [
        [{ ...input.groups[0][0], value: 'разработка' }, ...input.groups[0].slice(1)],
        input.groups[1],
      ],
    });
    expect(parsed.groups).not.toBe(input.groups);
    expect(parsed.groups[0]).not.toBe(input.groups[0]);
    expect(parsed.groups[0][0]).not.toBe(input.groups[0][0]);
    expect(parsed.sort).not.toBe(input.sort);
  });

  it('accepts no predicates, sort-only, and exact maximum bounds', () => {
    expect(parseSearchFilter(emptySearchFilter())).toEqual(emptySearchFilter());
    expect(
      parseSearchFilter({ ...emptySearchFilter(), sort: { field: 'name', direction: 'asc' } }).sort
        ?.field,
    ).toBe('name');
    expect(
      parseSearchFilter({
        groups: Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => condition)),
        sort: null,
        limit: 1000,
      }).groups,
    ).toHaveLength(8);
    expect(
      parseSearchFilter(withConditions({ field: 'name', op: 'contains', value: 'a'.repeat(500) }))
        .groups[0][0].value,
    ).toHaveLength(500);
  });

  it.each([
    null,
    [],
    {},
    { groups: [] },
    { name: null, level: null, headcount: null, budget: null, performance: null },
    { ...emptySearchFilter(), script: 'return true' },
    { ...emptySearchFilter(), groups: null },
    { ...emptySearchFilter(), groups: [[]] },
    { ...emptySearchFilter(), groups: [condition] },
    { ...emptySearchFilter(), groups: new Array(1) },
    { ...emptySearchFilter(), groups: [new Array(1)] },
    { ...emptySearchFilter(), groups: Array.from({ length: 9 }, () => [condition]) },
    { ...emptySearchFilter(), groups: [Array.from({ length: 9 }, () => condition)] },
    ...[0, -1, 1.5, 1001, Infinity, NaN, '3'].map((limit) => ({ ...emptySearchFilter(), limit })),
    ...[
      {},
      { field: 'script', direction: 'asc' },
      { field: 'name', direction: 'up' },
      { field: 'budget', direction: 'desc', extra: true },
    ].map((sort) => ({ ...emptySearchFilter(), sort })),
    ...[
      null,
      {},
      { field: 'name', op: 'contains', value: '' },
      { field: 'name', op: 'contains', value: ' '.repeat(20) },
      { field: 'name', op: 'contains', value: 'a'.repeat(501) },
      { field: 'name', op: 'eq', value: 'name' },
      { field: 'level', op: 'eq', value: '3' },
      { field: 'level', op: 'eq', value: 4 },
      { field: 'level', op: 'gt', value: 2 },
      { ...condition, value: '10' },
      { ...condition, value: -1 },
      { ...condition, value: NaN },
      { ...condition, value: Infinity },
      { ...condition, value: Number.MAX_SAFE_INTEGER + 1 },
      { ...condition, field: 'code' },
      { ...condition, op: '!==' },
      { ...condition, op: true },
      { ...condition, expression: 'process.exit()' },
    ].map((item) => ({ ...emptySearchFilter(), groups: [[item]] })),
  ])('rejects malformed, legacy or unbounded filters: %j', (value) => {
    expect(() => parseSearchFilter(value)).toThrow(TypeError);
  });
});

describe('matchesSearchFilter', () => {
  it('combines every constraint in an AND group and permits another OR group', () => {
    const filter: SearchFilter = {
      ...emptySearchFilter(),
      groups: [
        [
          { field: 'name', op: 'contains', value: 'СЕРВЕР' },
          { field: 'level', op: 'eq', value: 3 },
          condition,
        ],
        [
          { field: 'level', op: 'eq', value: 2 },
          { field: 'budget', op: 'eq', value: 5_000_000 },
        ],
      ],
    };
    expect(matchesSearchFilter(filter, 'Серверная разработка', 3, aggregate)).toBe(true);
    expect(matchesSearchFilter(filter, 'Любой отдел', 2, aggregate)).toBe(true);
    expect(matchesSearchFilter(filter, 'Веб-платформа', 3, aggregate)).toBe(false);
    expect(
      matchesSearchFilter(filter, 'Серверная разработка', 3, { ...aggregate, headcount: 9 }),
    ).toBe(false);
    expect(matchesSearchFilter(filter, 'Любой отдел', 2, { ...aggregate, budget: 4_000_000 })).toBe(
      false,
    );
  });

  it('uses both boundaries of a range on the same metric', () => {
    const filter = withConditions(
      { field: 'headcount', op: 'gte', value: 10 },
      { field: 'headcount', op: 'lte', value: 20 },
    );
    for (const headcount of [10, 12, 20])
      expect(matchesSearchFilter(filter, 'Team', 3, { ...aggregate, headcount })).toBe(true);
    for (const headcount of [9, 21])
      expect(matchesSearchFilter(filter, 'Team', 3, { ...aggregate, headcount })).toBe(false);
  });

  it.each<[NumericOperator, boolean]>([
    ['lt', false],
    ['lte', true],
    ['gt', false],
    ['gte', true],
    ['eq', true],
    ['ne', false],
  ])('honors exact numeric boundary and null for %s', (op, expected) => {
    const filter = withConditions({ field: 'performance', op, value: 80 });
    expect(matchesSearchFilter(filter, 'Team', 3, aggregate)).toBe(expected);
    expect(matchesSearchFilter(filter, 'Team', 3, { ...aggregate, performance: null })).toBe(false);
  });

  it('handles not-equal for level and metrics without treating null as unequal', () => {
    const filter = withConditions(
      { field: 'level', op: 'ne', value: 1 },
      { field: 'headcount', op: 'ne', value: 0 },
    );
    expect(matchesSearchFilter(filter, 'Team', 3, aggregate)).toBe(true);
    expect(matchesSearchFilter(filter, 'Division', 1, aggregate)).toBe(false);
    expect(
      matchesSearchFilter(emptySearchFilter(), 'Team', 3, { ...aggregate, performance: null }),
    ).toBe(true);
  });

  it('uses literal normalized substrings for inclusion and exclusion', () => {
    const filter = withConditions(
      { field: 'name', op: 'contains', value: 'учет' },
      { field: 'name', op: 'notContains', value: 'ВНУТРЕННИЙ' },
    );
    expect(matchesSearchFilter(filter, 'Учёт клиентов', 2, aggregate)).toBe(true);
    expect(matchesSearchFilter(filter, 'Внутренний учёт', 2, aggregate)).toBe(false);
    expect(
      matchesSearchFilter(
        withConditions({ field: 'name', op: 'contains', value: '.*' }),
        'Любое название',
        2,
        aggregate,
      ),
    ).toBe(false);
  });
});

describe('selection and sorting', () => {
  const nodes: OrgNode[] = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
    id,
    name: `Узел ${id}`,
    parentId: null,
    headcount: 1,
    budget: 1,
    performance: 80,
    updatedAt: '2026-09-15T10:00:00.000Z',
  }));
  const depths = new Map(nodes.map((node) => [node.id, node.id === 'a' ? 1 : 3]));
  const aggregates = new Map<string, OrgAggregate>(
    nodes.map((node, i) => [
      node.id,
      {
        headcount: [5, 4, 3, 99, 1][i],
        budget: 500 - i * 100,
        performance: i === 0 ? null : 80,
        nodeCount: 1,
      },
    ]),
  );
  const ids = (result: OrgNode[]) => result.map((node) => node.id);

  it('applies the manual level facet before top N, then reorders only selected members', () => {
    const filter: SearchFilter = {
      ...emptySearchFilter(),
      sort: { field: 'budget', direction: 'desc' },
      limit: 3,
    };
    const chosen = selectSearchNodes(filter, nodes, depths, aggregates, 3);
    expect(ids(chosen)).toEqual(['b', 'c', 'd']);
    expect(
      ids(sortSearchNodes(chosen, { field: 'headcount', direction: 'desc' }, depths, aggregates)),
    ).toEqual(['d', 'b', 'c']);
    expect(ids(chosen)).toEqual(['b', 'c', 'd']);
    const updated = new Map(aggregates);
    updated.set('e', { ...aggregates.get('e')!, budget: 700 });
    const next = selectSearchNodes(filter, nodes, depths, updated, 3);
    expect(ids(next)).toEqual(['e', 'b', 'c']);
    expect(
      ids(sortSearchNodes(next, { field: 'headcount', direction: 'desc' }, depths, updated)),
    ).toEqual(['b', 'c', 'e']);
  });

  it.each(['asc', 'desc'] as const)(
    'puts null metrics last and breaks ties by id in %s order',
    (direction) => {
      expect(
        ids(
          sortSearchNodes(
            [...nodes].reverse(),
            { field: 'performance', direction },
            depths,
            aggregates,
          ),
        ),
      ).toEqual(['b', 'c', 'd', 'e', 'a']);
    },
  );

  it('uses deterministic id order for a limit without a requested sort', () => {
    expect(
      ids(
        selectSearchNodes(
          { ...emptySearchFilter(), limit: 2 },
          [...nodes].reverse(),
          depths,
          aggregates,
        ),
      ),
    ).toEqual(['a', 'b']);
  });
});
