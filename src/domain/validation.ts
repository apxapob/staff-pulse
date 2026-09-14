import type {
  DatasetValidationResult,
  OrgEmployee,
  OrgNode,
  ValidationCode,
  ValidationIssue,
} from './types';

const requiredFields = [
  'id',
  'name',
  'parentId',
  'headcount',
  'budget',
  'performance',
  'updatedAt',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Date.parse alone normalizes impossible dates such as February 30. */
function isIsoDateTime(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (monthDays[month - 1] ?? 0) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    (!match[7] || (Number(match[8]) <= 23 && Number(match[9]) <= 59)) &&
    Number.isFinite(Date.parse(value))
  );
}

export function validateDataset(input: unknown): DatasetValidationResult {
  const errors: ValidationIssue[] = [];
  const addError = (path: string, code: ValidationCode, message: string) => {
    errors.push({ path, code, message });
  };

  if (!Array.isArray(input)) {
    return {
      ok: false,
      errors: [{ path: '$', code: 'array', message: 'The dataset must be a JSON array.' }],
    };
  }

  const nodes: OrgNode[] = [];
  input.forEach((entry: unknown, row: number) => {
    const path = `$[${row}]`;
    if (!isRecord(entry)) {
      addError(path, 'object', 'Each node must be an object.');
      return;
    }

    const errorsBefore = errors.length;
    for (const field of requiredFields) {
      if (!Object.hasOwn(entry, field)) {
        addError(`${path}.${field}`, 'required', `The ${field} field is required.`);
      }
    }
    for (const field of ['id', 'name'] as const) {
      if (
        Object.hasOwn(entry, field) &&
        (typeof entry[field] !== 'string' || entry[field].trim() === '')
      ) {
        addError(`${path}.${field}`, 'string', `The ${field} field must be a non-empty string.`);
      }
    }
    if (
      Object.hasOwn(entry, 'parentId') &&
      entry.parentId !== null &&
      (typeof entry.parentId !== 'string' || entry.parentId.trim() === '')
    ) {
      addError(
        `${path}.parentId`,
        'string',
        'The parentId field must be a non-empty string or null.',
      );
    }

    for (const field of ['headcount', 'budget', 'performance'] as const) {
      if (!Object.hasOwn(entry, field)) continue;
      const value = entry[field];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        addError(`${path}.${field}`, 'number', `The ${field} field must be a finite number.`);
      } else if (field === 'headcount' && (!Number.isSafeInteger(value) || value < 0)) {
        addError(`${path}.${field}`, 'range', 'Headcount must be a non-negative safe integer.');
      } else if (field === 'budget' && value < 0) {
        addError(`${path}.${field}`, 'range', 'Budget must be non-negative.');
      } else if (field === 'performance' && (value < 0 || value > 100)) {
        addError(`${path}.${field}`, 'range', 'Performance must be between 0 and 100.');
      }
    }

    if (
      Object.hasOwn(entry, 'updatedAt') &&
      (typeof entry.updatedAt !== 'string' || !isIsoDateTime(entry.updatedAt))
    ) {
      addError(
        `${path}.updatedAt`,
        'datetime',
        'updatedAt must be a valid ISO datetime with a timezone.',
      );
    }

    let employees: OrgEmployee[] | undefined;
    if (Object.hasOwn(entry, 'employees')) {
      if (!Array.isArray(entry.employees)) {
        addError(`${path}.employees`, 'array', 'Employees must be a JSON array.');
      } else {
        employees = [];
        for (const [position, employee] of entry.employees.entries()) {
          const employeePath = `${path}.employees[${position}]`;
          if (!isRecord(employee)) {
            addError(employeePath, 'object', 'Each employee must be an object.');
            continue;
          }
          const employeeErrorsBefore = errors.length;
          for (const field of ['id', 'name', 'role'] as const) {
            if (!Object.hasOwn(employee, field)) {
              addError(`${employeePath}.${field}`, 'required', `The ${field} field is required.`);
            } else if (typeof employee[field] !== 'string' || employee[field].trim() === '') {
              addError(
                `${employeePath}.${field}`,
                'string',
                `The ${field} field must be a non-empty string.`,
              );
            }
          }
          if (errors.length === employeeErrorsBefore) {
            employees.push({
              id: employee.id as string,
              name: employee.name as string,
              role: employee.role as string,
            });
          }
        }
        if (entry.employees.length !== entry.headcount) {
          addError(
            `${path}.employees`,
            'range',
            'The employee roster length must equal headcount.',
          );
        }
      }
    }

    if (errors.length === errorsBefore) {
      // Copy only the declared schema: imported objects cannot add runtime state.
      nodes.push({
        id: entry.id as string,
        name: entry.name as string,
        parentId: entry.parentId as string | null,
        headcount: entry.headcount as number,
        budget: entry.budget as number,
        performance: entry.performance as number,
        updatedAt: entry.updatedAt as string,
        ...(employees === undefined ? {} : { employees }),
      });
    }
  });

  if (errors.length > 0) return { ok: false, errors };

  const rowsById = new Map<string, number>();
  const employeeIds = new Set<string>();
  nodes.forEach((node, row) => {
    if (rowsById.has(node.id)) {
      addError(`$[${row}].id`, 'duplicate', `Duplicate node ID "${node.id}".`);
    } else {
      rowsById.set(node.id, row);
    }
    node.employees?.forEach((employee, position) => {
      if (employeeIds.has(employee.id)) {
        addError(
          `$[${row}].employees[${position}].id`,
          'duplicate',
          `Duplicate employee ID "${employee.id}".`,
        );
      }
      employeeIds.add(employee.id);
    });
  });
  if (errors.length > 0) return { ok: false, errors };

  nodes.forEach((node, row) => {
    if (node.parentId !== null && !rowsById.has(node.parentId)) {
      addError(`$[${row}].parentId`, 'parent', `Parent "${node.parentId}" does not exist.`);
    }
  });
  if (errors.length > 0) return { ok: false, errors };

  // Follow parent links iteratively. Every node is visited at most twice.
  const settled = new Set<string>();
  for (const node of nodes) {
    if (settled.has(node.id)) continue;
    const path = new Set<string>();
    let currentId: string | null = node.id;
    while (currentId !== null && !settled.has(currentId)) {
      if (path.has(currentId)) {
        addError(
          `$[${rowsById.get(currentId)}].parentId`,
          'cycle',
          `The parent chain of "${currentId}" contains a cycle.`,
        );
        break;
      }
      path.add(currentId);
      const row = rowsById.get(currentId);
      currentId = row === undefined ? null : (nodes[row]?.parentId ?? null);
    }
    for (const id of path) settled.add(id);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, nodes };
}

export class DatasetValidationError extends Error {
  readonly errors: readonly ValidationIssue[];

  constructor(errors: readonly ValidationIssue[]) {
    super(errors.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
    this.name = 'DatasetValidationError';
    this.errors = errors;
  }
}

export function parseDataset(input: unknown): OrgNode[] {
  const result = validateDataset(input);
  if (!result.ok) throw new DatasetValidationError(result.errors);
  return result.nodes;
}
