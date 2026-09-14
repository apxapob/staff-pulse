export const SEARCH_COMPARISON_DESCRIPTION =
  'Exact source and complete valid filter; AI OR/AND order and identical AND duplicates are ignored, names are case-insensitive, and same-field gte N AND lte N equals eq N. Other operators, constraints, sort and limit remain exact.';

const numericFields = ['headcount', 'budget', 'performance'];
const sortFields = ['name', 'level', ...numericFields];
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

function validCondition(condition) {
  if (!exactKeys(condition, ['field', 'op', 'value'])) return false;
  const { field, op, value } = condition;
  if (field === 'name')
    return (
      ['contains', 'notContains'].includes(op) &&
      typeof value === 'string' &&
      value.trim().length >= 1 &&
      value.trim().length <= 500
    );
  if (field === 'level') return ['eq', 'ne'].includes(op) && [1, 2, 3].includes(value);
  return (
    numericFields.includes(field) &&
    ['lt', 'lte', 'gt', 'gte', 'eq', 'ne'].includes(op) &&
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

// Keep the JSON contract strict before normalization: invalid/oversized groups
// must not become valid by collapsing conditions. This module stays runnable in
// plain Node; the tests check these guards against the domain's TS validator.
function validFilter(filter) {
  if (!exactKeys(filter, ['groups', 'sort', 'limit'])) return false;
  if (!Array.isArray(filter.groups) || filter.groups.length > 8) return false;
  if (
    !Array.from(filter.groups).every(
      (group) =>
        Array.isArray(group) &&
        group.length >= 1 &&
        group.length <= 8 &&
        Array.from(group).every(validCondition),
    )
  )
    return false;
  if (
    filter.sort !== null &&
    (!exactKeys(filter.sort, ['field', 'direction']) ||
      !sortFields.includes(filter.sort.field) ||
      !['asc', 'desc'].includes(filter.sort.direction))
  )
    return false;
  return (
    filter.limit === null ||
    (Number.isInteger(filter.limit) && filter.limit >= 1 && filter.limit <= 1000)
  );
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

function canonicalAnd(group) {
  const conditions = group.map((condition) => {
    if (condition.field === 'name')
      return { ...condition, value: condition.value.toLocaleLowerCase('ru-RU') };
    if (
      numericFields.includes(condition.field) &&
      (condition.op === 'gte' || condition.op === 'lte') &&
      group.some(
        (other) =>
          other.field === condition.field &&
          other.value === condition.value &&
          other.op === (condition.op === 'gte' ? 'lte' : 'gte'),
      )
    )
      return { ...condition, op: 'eq' };
    return condition;
  });
  return [...new Set(conditions.map((condition) => JSON.stringify(canonical(condition))))]
    .sort()
    .map((condition) => JSON.parse(condition));
}

function comparable(result) {
  const filter = result.filter;
  return JSON.stringify(
    canonical({
      source: result.source,
      filter:
        result.source === 'ai'
          ? {
              ...filter,
              groups: filter.groups
                .map(canonicalAnd)
                .map((group) => JSON.stringify(group))
                .sort()
                .map((group) => JSON.parse(group)),
            }
          : filter,
    }),
  );
}

export function searchResultsEqual(actual, expected) {
  if (
    !['ai', 'local', 'text'].includes(actual?.source) ||
    !['ai', 'local', 'text'].includes(expected?.source) ||
    !validFilter(actual?.filter) ||
    !validFilter(expected?.filter)
  )
    return false;
  return comparable(actual) === comparable(expected);
}
