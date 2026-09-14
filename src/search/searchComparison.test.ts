import { describe, expect, it } from 'vitest';
import { searchResultsEqual } from '../../scripts/search-comparison.mjs';
import {
  emptySearchFilter,
  matchesSearchFilter,
  parseSearchFilter,
  type SearchCondition,
  type SearchFilter,
} from './filter';

const aggregate = { headcount: 12, budget: 850_000, performance: 76.5, nodeCount: 1 };
const result = (filter: SearchFilter, source = 'ai') => ({ filter, source });
const conditions = (...group: SearchCondition[]): SearchFilter => ({
  ...emptySearchFilter(),
  groups: [group],
});
const budgetEq = conditions({ field: 'budget', op: 'eq', value: 850_000 });
const budgetPoint = conditions(
  { field: 'budget', op: 'gte', value: 850_000 },
  { field: 'budget', op: 'lte', value: 850_000 },
);

describe('model evaluation comparison', () => {
  it.each(['headcount', 'budget', 'performance'] as const)(
    'accepts a closed point interval as equality for %s, matching domain predicates',
    (field) => {
      const value = aggregate[field];
      const equal = conditions({ field, op: 'eq', value });
      const point = conditions({ field, op: 'gte', value }, { field, op: 'lte', value });
      expect(searchResultsEqual(result(point), result(equal))).toBe(true);
      expect(searchResultsEqual(result(equal), result(point))).toBe(true);
      for (const measured of [value - 1, value, value + 1]) {
        const metrics = { ...aggregate, [field]: measured };
        expect(matchesSearchFilter(point, 'Team', 3, metrics)).toBe(measured === value);
        expect(matchesSearchFilter(equal, 'Team', 3, metrics)).toBe(measured === value);
      }
    },
  );

  it('preserves null and nonfinite metric behavior when collapsing an interval', () => {
    const equal = conditions({ field: 'performance', op: 'eq', value: 0 });
    const point = conditions(
      { field: 'performance', op: 'gte', value: 0 },
      { field: 'performance', op: 'lte', value: 0 },
    );
    expect(searchResultsEqual(result(point), result(equal))).toBe(true);
    for (const performance of [null, NaN, Infinity]) {
      const metrics = { ...aggregate, performance };
      expect(matchesSearchFilter(equal, 'Team', 3, metrics)).toBe(false);
      expect(matchesSearchFilter(point, 'Team', 3, metrics)).toBe(false);
    }
    expect(matchesSearchFilter(point, 'Team', 3, { ...aggregate, performance: 0 })).toBe(true);
  });

  it('collapses only within each AND group, deduplicates conditions and preserves other constraints', () => {
    const other: SearchCondition[] = [
      { field: 'level', op: 'eq', value: 2 },
      { field: 'performance', op: 'gte', value: 76 },
    ];
    const equal = conditions(...other, ...budgetEq.groups[0]);
    const point = conditions(...budgetPoint.groups[0], ...other, ...budgetPoint.groups[0]);
    const before = structuredClone(point);
    expect(searchResultsEqual(result(point), result(equal))).toBe(true);
    expect(point).toEqual(before);
    for (const level of [1, 2, 3])
      for (const performance of [null, 75, 76, 100]) {
        const metrics = { ...aggregate, performance };
        expect(matchesSearchFilter(point, 'Team', level, metrics)).toBe(
          matchesSearchFilter(equal, 'Team', level, metrics),
        );
      }
    expect(searchResultsEqual(result(point), result(budgetEq))).toBe(false);
    expect(searchResultsEqual(result(point), result({ ...equal, limit: 1 }))).toBe(false);
    expect(
      searchResultsEqual(
        result(point),
        result({ ...equal, sort: { field: 'budget', direction: 'desc' } }),
      ),
    ).toBe(false);
    expect(searchResultsEqual(result(point, 'local'), result(equal))).toBe(false);
  });

  it.each([
    { op: 'gt', upper: 850_000, witness: 850_000 },
    { op: 'gte', upper: 850_001, witness: 850_000.5 },
  ] as const)('rejects a strict or non-point interval: %j', ({ op, upper, witness }) => {
    const interval = conditions(
      { field: 'budget', op, value: 850_000 },
      { field: 'budget', op: 'lte', value: upper },
    );
    expect(searchResultsEqual(result(interval), result(budgetEq))).toBe(false);
    const metrics = { ...aggregate, budget: witness };
    expect(matchesSearchFilter(interval, 'Team', 3, metrics)).not.toBe(
      matchesSearchFilter(budgetEq, 'Team', 3, metrics),
    );
  });

  it('does not merge bounds across OR branches or different fields, or erase extra conditions', () => {
    const variants: SearchFilter[] = [
      { ...emptySearchFilter(), groups: budgetPoint.groups[0].map((bound) => [bound]) },
      conditions(
        { field: 'budget', op: 'gte', value: 850_000 },
        { field: 'headcount', op: 'lte', value: 850_000 },
      ),
      conditions(...budgetPoint.groups[0], { field: 'budget', op: 'ne', value: 850_000 }),
    ];
    for (const filter of variants)
      expect(searchResultsEqual(result(filter), result(budgetEq))).toBe(false);
  });

  it('retains existing unordered AI comparison and literal text fallback', () => {
    const a = {
      ...emptySearchFilter(),
      groups: [[{ field: 'name', op: 'contains', value: 'Team' }], [...budgetPoint.groups[0]]],
    } as SearchFilter;
    const b = {
      ...emptySearchFilter(),
      groups: [budgetEq.groups[0], [{ field: 'name', op: 'contains', value: 'TEAM' }]],
    } as SearchFilter;
    expect(searchResultsEqual(result(a), result(b))).toBe(true);
    const text = conditions({ field: 'name', op: 'contains', value: 'Whole original query' });
    const changed = conditions({ field: 'name', op: 'contains', value: 'whole original query' });
    expect(searchResultsEqual(result(text, 'text'), result(text, 'text'))).toBe(true);
    expect(searchResultsEqual(result(text, 'text'), result(changed, 'text'))).toBe(false);
  });

  it.each([
    null,
    {},
    { name: null, level: null, headcount: null, budget: null, performance: null },
    { ...budgetPoint, unknown: true },
    { ...budgetPoint, unknown: undefined },
    { ...budgetPoint, groups: [[]] },
    { ...budgetPoint, groups: new Array(1) },
    { ...budgetPoint, groups: [new Array(1)] },
    { ...budgetPoint, groups: Array.from({ length: 9 }, () => budgetPoint.groups[0]) },
    {
      ...budgetPoint,
      groups: [
        [...budgetPoint.groups[0], ...Array.from({ length: 7 }, () => budgetPoint.groups[0][0])],
      ],
    },
    { ...budgetPoint, sort: { field: 'budget', direction: 'desc', extra: true } },
    { ...budgetPoint, limit: 0 },
    { ...budgetPoint, limit: 1001 },
    { ...budgetPoint, limit: undefined },
    ...[
      { field: 'salary', op: 'gte', value: 850_000 },
      { field: 'level', op: 'gte', value: 2 },
      { field: 'budget', op: 'gte', value: '850000' },
      { field: 'budget', op: 'gte', value: null },
      { field: 'budget', op: 'gte', value: NaN },
      { field: 'budget', op: 'gte', value: Infinity },
      { field: 'budget', op: 'gte', value: -1 },
      { field: 'budget', op: 'gte', value: 850_000, extra: true },
      { field: 'name', op: 'contains', value: '' },
    ].map((condition) => ({ ...budgetPoint, groups: [[condition, budgetPoint.groups[0][1]]] })),
  ])(
    'rejects malformed filters before normalization, consistently with the domain: %j',
    (filter) => {
      expect(() => parseSearchFilter(filter)).toThrow();
      expect(searchResultsEqual({ source: 'ai', filter }, result(budgetEq))).toBe(false);
      expect(searchResultsEqual({ source: 'ai', filter }, { source: 'ai', filter })).toBe(false);
    },
  );
});
