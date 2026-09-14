import { describe, expect, it } from 'vitest';
import type { OrgNode, ValidationCode } from './types';
import { DatasetValidationError, parseDataset, validateDataset } from './validation';

const node = (overrides: Partial<OrgNode> = {}): OrgNode => ({
  id: 'division',
  name: 'Engineering',
  parentId: null,
  headcount: 3,
  budget: 1200,
  performance: 80,
  updatedAt: '2026-09-14T12:00:00.000Z',
  ...overrides,
});

function expectIssue(input: unknown, code: ValidationCode, path?: string) {
  const result = validateDataset(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected an invalid dataset.');
  expect(result.errors).toEqual(
    expect.arrayContaining([expect.objectContaining({ code, ...(path ? { path } : {}) })]),
  );
}

describe('validateDataset', () => {
  it('accepts an empty dataset', () => {
    expect(validateDataset([])).toEqual({ ok: true, nodes: [] });
  });

  it('accepts unordered nodes and multiple roots without mutating input', () => {
    const input = [node({ id: 'child', parentId: 'division' }), node(), node({ id: 'other' })];
    const result = validateDataset(input);
    expect(result).toEqual({ ok: true, nodes: input });
    if (result.ok) expect(result.nodes[0]).not.toBe(input[0]);
  });

  it('copies only schema fields from imported objects', () => {
    const result = parseDataset([{ ...node(), selected: true, expanded: true }]);
    expect(result).toEqual([node()]);
  });

  it('copies optional employee records deeply and retains only their declared fields', () => {
    const employee = { id: 'employee-1', name: 'Ada Lovelace', role: 'Engineer', selected: true };
    const input = node({ headcount: 1, employees: [employee] });
    const parsed = parseDataset([input])[0];
    expect(parsed?.employees).toEqual([
      { id: 'employee-1', name: 'Ada Lovelace', role: 'Engineer' },
    ]);
    expect(parsed?.employees).not.toBe(input.employees);
    expect(parsed?.employees?.[0]).not.toBe(employee);
    expect(parseDataset([node()])[0]).not.toHaveProperty('employees');
    expect(parseDataset([node({ headcount: 0, employees: [] })])[0]?.employees).toEqual([]);
  });

  it.each([
    [undefined, 'array', '$[0].employees'],
    [null, 'array', '$[0].employees'],
    [{}, 'array', '$[0].employees'],
    [[null], 'object', '$[0].employees[0]'],
    [[{ id: 'e', name: 'Ada' }], 'required', '$[0].employees[0].role'],
    [[{ id: '', name: 'Ada', role: 'Engineer' }], 'string', '$[0].employees[0].id'],
    [[{ id: 'e', name: 1, role: 'Engineer' }], 'string', '$[0].employees[0].name'],
    [[{ id: 'e', name: 'Ada', role: ' ' }], 'string', '$[0].employees[0].role'],
    [[], 'range', '$[0].employees'],
  ] as const)('rejects invalid roster %j', (employees, code, path) => {
    expectIssue([{ ...node({ headcount: 1 }), employees }], code, path);
  });

  it('requires employee identifiers to be unique within and across nodes', () => {
    const employee = { id: 'employee-1', name: 'Ada', role: 'Engineer' };
    expectIssue(
      [node({ headcount: 2, employees: [employee, employee] })],
      'duplicate',
      '$[0].employees[1].id',
    );
    expectIssue(
      [
        node({ headcount: 1, employees: [employee] }),
        node({ id: 'other', headcount: 1, employees: [employee] }),
      ],
      'duplicate',
      '$[1].employees[0].id',
    );
  });

  it.each([null, {}, '[]', 1])('requires an array instead of %j', (input) => {
    expectIssue(input, 'array', '$');
  });

  it.each([null, [], 2, 'node'])('rejects non-object row %j', (input) => {
    expectIssue([input], 'object', '$[0]');
  });

  it('reports missing fields at their source row', () => {
    expectIssue([{}], 'required', '$[0].parentId');
  });

  it.each([{ id: ' ' }, { name: '' }, { parentId: '' }, { parentId: 0 }])(
    'rejects empty or incorrectly typed identifiers/names %j',
    (fields) => {
      expectIssue([{ ...node(), ...fields }], 'string');
    },
  );

  it.each([
    ['headcount', -1, 'range'],
    ['headcount', 1.5, 'range'],
    ['headcount', Number.MAX_SAFE_INTEGER + 1, 'range'],
    ['headcount', '10', 'number'],
    ['budget', -0.1, 'range'],
    ['budget', Infinity, 'number'],
    ['performance', NaN, 'number'],
    ['performance', -1, 'range'],
    ['performance', 101, 'range'],
  ] as const)('rejects invalid %s = %s', (field, value, code) => {
    expectIssue([{ ...node(), [field]: value }], code, `$[0].${field}`);
  });

  it.each([0, 100])('accepts performance boundary %s and zero metrics', (performance) => {
    expect(validateDataset([node({ headcount: 0, budget: 0, performance })]).ok).toBe(true);
  });

  it.each([
    '2026-09-14',
    '2026-09-14T12:00:00',
    '2026-02-30T12:00:00Z',
    '2025-02-29T12:00:00Z',
    '2026-13-01T12:00:00Z',
    '2026-09-14T24:00:00Z',
    'yesterday',
  ])('rejects invalid ISO timestamp %s', (updatedAt) => {
    expectIssue([node({ updatedAt })], 'datetime', '$[0].updatedAt');
  });

  it.each(['2024-02-29T12:00:00Z', '2026-09-14T12:00:00.123+03:00'])(
    'accepts ISO timestamp %s',
    (updatedAt) => {
      expect(validateDataset([node({ updatedAt })]).ok).toBe(true);
    },
  );

  it('rejects duplicates with a row-specific error', () => {
    expectIssue([node(), node()], 'duplicate', '$[1].id');
  });

  it('rejects dangling parent references', () => {
    expectIssue([node({ parentId: 'missing' })], 'parent', '$[0].parentId');
  });

  it('rejects a node that parents itself', () => {
    expectIssue([node({ parentId: 'division' })], 'cycle', '$[0].parentId');
  });

  it('finds a disconnected cycle even when valid roots exist', () => {
    expectIssue(
      [
        node(),
        node({ id: 'a', parentId: 'b' }),
        node({ id: 'b', parentId: 'c' }),
        node({ id: 'c', parentId: 'a' }),
      ],
      'cycle',
    );
  });

  it('supports special JavaScript property names as IDs', () => {
    expect(
      validateDataset([
        node({ id: '__proto__' }),
        node({ id: 'constructor', parentId: '__proto__' }),
      ]).ok,
    ).toBe(true);
  });

  it('handles a deep parent chain without overflowing the call stack', () => {
    const input = Array.from({ length: 15_000 }, (_, i) =>
      node({
        id: String(i),
        parentId: i === 0 ? null : String(i - 1),
      }),
    ).reverse();
    expect(validateDataset(input).ok).toBe(true);
  });
});

describe('parseDataset', () => {
  it('throws a typed error retaining validation details', () => {
    expect(() => parseDataset(null)).toThrow(DatasetValidationError);
    try {
      parseDataset(null);
    } catch (error) {
      expect(error).toMatchObject({
        name: 'DatasetValidationError',
        errors: [{ path: '$', code: 'array', message: expect.any(String) }],
      });
    }
  });
});
