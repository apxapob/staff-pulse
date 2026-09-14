import {
  emptySearchFilter,
  parseSearchFilter,
  type NumericOperator,
  type SearchCondition,
  type SearchFilter,
  type SearchSortField,
} from '../src/search/filter.js';

type Metric = 'headcount' | 'budget' | 'performance';
const comparisons: Record<string, NumericOperator> = {
  'не менее': 'gte',
  'не меньше': 'gte',
  'не ниже': 'gte',
  'не более': 'lte',
  'не больше': 'lte',
  'не выше': 'lte',
  'не равно': 'ne',
  'не равной': 'ne',
  'не равна': 'ne',
  '>=': 'gte',
  '≥': 'gte',
  '<=': 'lte',
  '≤': 'lte',
  '!=': 'ne',
  '≠': 'ne',
  больше: 'gt',
  более: 'gt',
  выше: 'gt',
  свыше: 'gt',
  '>': 'gt',
  меньше: 'lt',
  менее: 'lt',
  ниже: 'lt',
  '<': 'lt',
  равно: 'eq',
  ровно: 'eq',
  '=': 'eq',
};
const comparisonPattern = Object.keys(comparisons).join('|');
const numberPattern = '(\\d+(?: \\d{3})*(?:[.,]\\d+)?)';
const unitPattern =
  '(млн|миллион(?:а|ов)?|млрд|миллиард(?:а|ов)?|тыс\\.?|тысяч(?:а|и)?|руб\\.?|рубл(?:ь|я|ей)|₽)?';
const suffixes: Record<Metric, string> = {
  headcount: '(?:сотрудник(?:а|ов)?|человек)?',
  budget: '(?:₽|руб\\.?|рубл(?:ь|я|ей))?',
  performance: '(?:%|процент(?:а|ов)?)?',
};
const metricPrefixes: Array<[Metric, RegExp]> = [
  ['performance', /^(?:эффективност(?:ь|ью|и)|результативност(?:ь|ью|и)|performance)\s+/],
  ['budget', /^бюджет(?:ом|а)?\s+/],
  [
    'headcount',
    /^(?:численност(?:ь|ью|и)|штат(?:ом)?|количеств(?:о|ом) сотрудников|сотрудников)\s+/,
  ],
];
const levelPrefix =
  /^(?:все\s+)?(не\s+)?(дивизион(?:ы|ов|а)?|отдел(?:ы|ов|а)?|команд(?:а|ы)?)(?=\s|$)/;
const genericPrefix = /^(?:все\s+)?подразделени(?:я|й)(?=\s|$)\s*/;
const countWords: Record<string, number> = {
  один: 1,
  одну: 1,
  одна: 1,
  два: 2,
  две: 2,
  три: 3,
  четыре: 4,
  пять: 5,
  шесть: 6,
  семь: 7,
  восемь: 8,
  девять: 9,
  десять: 10,
};

function readNumber(text: string): number {
  return Number(text.replaceAll(' ', '').replace(',', '.'));
}

function multiplier(unit: string): number {
  return unit.startsWith('млрд') || unit.startsWith('миллиард')
    ? 1_000_000_000
    : unit.startsWith('млн') || unit.startsWith('миллион')
      ? 1_000_000
      : unit.startsWith('тыс')
        ? 1_000
        : 1;
}

function numericConditions(field: Metric, text: string): SearchCondition[] | null {
  const unit = field === 'budget' ? `\\s*${unitPattern}` : '';
  const range = text.match(
    new RegExp(
      `^от\\s+${numberPattern}${unit}\\s+до\\s+${numberPattern}${unit}\\s*${suffixes[field]}$`,
    ),
  );
  if (range) {
    const low = readNumber(range[1]);
    const high = readNumber(range[field === 'budget' ? 3 : 2]);
    const lowScale = field === 'budget' ? multiplier(range[2] || range[4] || '') : 1;
    const highScale = field === 'budget' ? multiplier(range[4] || range[2] || '') : 1;
    if (low * lowScale > high * highScale) return null;
    return [
      { field, op: 'gte', value: low * lowScale },
      { field, op: 'lte', value: high * highScale },
    ];
  }
  const match = text.match(
    new RegExp(`^(${comparisonPattern})\\s*${numberPattern}${unit}\\s*${suffixes[field]}$`),
  );
  if (!match) return null;
  return [
    {
      field,
      op: comparisons[match[1]],
      value: readNumber(match[2]) * (field === 'budget' ? multiplier(match[3] || '') : 1),
    },
  ];
}

function extractLevel(text: string) {
  const match = text.match(levelPrefix);
  if (!match) return null;
  const condition: SearchCondition = {
    field: 'level',
    op: match[1] ? 'ne' : 'eq',
    value: match[2].startsWith('дивизион') ? 1 : match[2].startsWith('отдел') ? 2 : 3,
  };
  return { condition, rest: text.slice(match[0].length).trim() };
}

function sortField(text: string): SearchSortField | null {
  if (/^бюджет(?:у|ом|а)?$/.test(text)) return 'budget';
  if (/^(?:эффективност(?:и|ью|ь)|результативност(?:и|ью|ь))$/.test(text)) return 'performance';
  if (/^(?:численност(?:и|ью|ь)|количеству сотрудников)$/.test(text)) return 'headcount';
  if (/^названи(?:ю|ем|е)$/.test(text)) return 'name';
  if (/^уровн(?:ю|ем|ь)$/.test(text)) return 'level';
  return null;
}

function extractSort(text: string): { rest: string; sort: SearchFilter['sort'] } {
  const explicit = text.match(
    /(?:^|\s+)(?:и\s+)?(?:отсортируй\s+|сортировка\s+)?по (.+?) по (возрастанию|убыванию)$/,
  );
  if (explicit) {
    const field = sortField(explicit[1]);
    if (field)
      return {
        rest: text.slice(0, explicit.index).trim(),
        sort: { field, direction: explicit[2] === 'возрастанию' ? 'asc' : 'desc' },
      };
  }
  const ranked = text.match(
    /(?:^|\s+)с (?:сам(?:ым|ой) )?(большим|высоким|высокой|наибольшим|наивысшей|маленьким|низким|низкой|наименьшим|наименьшей) (бюджетом|численностью|эффективностью)$/,
  );
  if (ranked) {
    const field = sortField(ranked[2]);
    if (field)
      return {
        rest: text.slice(0, ranked.index).trim(),
        sort: { field, direction: /^(?:маленьким|низк|наименьш)/.test(ranked[1]) ? 'asc' : 'desc' },
      };
  }
  return { rest: text, sort: null };
}

/** Recognizes complete clauses only; an unknown suffix invalidates the entire query. */
export function parseLocalSearch(query: string): SearchFilter | null {
  if (query.length > 500 || /[\u0001\u0002]/.test(query)) return null;
  const names: string[] = [];
  let text = query
    .toLocaleLowerCase('ru-RU')
    .replaceAll('ё', 'е')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .replace(/["«]([^"»]+)["»]/g, (_match, value: string) => `\u0001${names.push(value) - 1}\u0002`)
    .replace(/больше или равно/g, '>=')
    .replace(/меньше или равно/g, '<=')
    .replace(/,\s+(?=где|у которых)/g, ' ')
    .replace(/^(?:найди|найти|покажи|показать|выведи|выбери|выбрать)\s+/, '');
  const filter = emptySearchFilter();
  const count = text.match(
    new RegExp(`^(топ[- ]?)?(\\d+|${Object.keys(countWords).join('|')})\\s+`),
  );
  if (count) {
    filter.limit = countWords[count[2]] ?? Number(count[2]);
    text = text.slice(count[0].length);
  }
  const rankedPrefix = text.match(/^сам(?:ые|ых) (эффективн(?:ые|ых)|многочисленн(?:ые|ых))\s+/);
  if (rankedPrefix) {
    filter.sort = {
      field: rankedPrefix[1].startsWith('эффектив') ? 'performance' : 'headcount',
      direction: 'desc',
    };
    text = text.slice(rankedPrefix[0].length);
  }
  const sorted = extractSort(text);
  if (sorted.sort) {
    if (filter.sort) return null;
    filter.sort = sorted.sort;
    text = sorted.rest;
  }
  if (count?.[1] && !filter.sort) return null;
  const branches = text.split(/\s+или\s+/);
  if (branches.length > 8) return null;
  const inherited = extractLevel(branches[0])?.condition;
  const restoreName = (value: string): string | null => {
    // A quoted name is a complete operand; trailing clauses cannot become part of it.
    if (/[\u0001\u0002]/.test(value) && !/^\u0001\d+\u0002$/.test(value)) return null;
    if (/\s+(?:с|со|где|у которых|за)\s+/.test(value)) return null;
    const restored = value.replace(
      /\u0001(\d+)\u0002/g,
      (_match, index: string) => names[Number(index)],
    );
    return restored && !/[\u0001\u0002]/.test(restored) ? restored : null;
  };
  for (let index = 0; index < branches.length; index++) {
    const ownLevel = extractLevel(branches[index]);
    const level =
      ownLevel?.condition ??
      (index > 0 && !genericPrefix.test(branches[index]) ? inherited : undefined);
    const conditions: SearchCondition[] = level ? [level] : [];
    let remaining = (ownLevel?.rest ?? branches[index]).replace(genericPrefix, '').trim();
    remaining = remaining.replace(/^(?:с|со|где|у которых)\s+/, '');
    let lastMetric: Metric | undefined;
    for (const rawClause of remaining ? remaining.split(/\s+и\s+/) : []) {
      const clause = rawClause.replace(/^(?:с|со)\s+/, '');
      if (clause === 'без сотрудников' || clause === 'без бюджета') {
        const field = clause === 'без сотрудников' ? 'headcount' : 'budget';
        conditions.push({ field, op: 'eq', value: 0 });
        lastMetric = field;
        continue;
      }
      const excludedLevel = clause.startsWith('кроме ')
        ? extractLevel(clause.slice('кроме '.length))
        : null;
      if (excludedLevel?.rest === '' && excludedLevel.condition.op === 'eq') {
        conditions.push({ ...excludedLevel.condition, op: 'ne' });
        lastMetric = undefined;
        continue;
      }
      const named = clause.match(
        /^(?:названи(?:е|ем)\s+(не содержит|содержит)\s+|названием\s+|кроме\s+)(.+)$/,
      );
      if (named) {
        const value = restoreName(named[2]);
        if (!value) return null;
        conditions.push({
          field: 'name',
          op:
            named[1] === 'не содержит' || clause.startsWith('кроме ') ? 'notContains' : 'contains',
          value,
        });
        lastMetric = undefined;
        continue;
      }
      const prefix = metricPrefixes.find(([, pattern]) => pattern.test(clause));
      let metric = prefix?.[0];
      let numeric = metric ? numericConditions(metric, clause.replace(prefix![1], '')) : null;
      if (!metric && /(?:сотрудник(?:а|ов)?|человек)$/.test(clause)) {
        metric = 'headcount';
        numeric = numericConditions(metric, clause);
      }
      if (!metric && lastMetric) {
        metric = lastMetric;
        numeric = numericConditions(metric, clause);
      }
      if (!numeric || !metric) return null;
      conditions.push(...numeric);
      lastMetric = metric;
    }
    if (conditions.length) filter.groups.push(conditions);
    else if (branches.length !== 1 || (!filter.sort && filter.limit === null)) return null;
  }
  try {
    return parseSearchFilter(filter);
  } catch {
    return null;
  }
}
