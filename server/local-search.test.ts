import { describe, expect, it, vi } from 'vitest';
import { emptySearchFilter, type SearchCondition, type SearchFilter } from '../src/search/filter';
import { parseLocalSearch } from './local-search';
import { resolveSearch } from './search';

const and = (...conditions: SearchCondition[]): SearchFilter => ({
  ...emptySearchFilter(),
  groups: [conditions],
});
const level = (value: 1 | 2 | 3): SearchCondition => ({ field: 'level', op: 'eq', value });
const below80 = and(level(3), { field: 'performance', op: 'lt', value: 80 });

describe('complete local search grammar', () => {
  it.each([
    ['Команды с эффективностью ниже 80%', below80],
    [
      'Покажи все команды с эффективностью не ниже 80 процентов',
      and(level(3), { field: 'performance', op: 'gte', value: 80 }),
    ],
    [
      'Отделы с бюджетом больше 5 млн',
      and(level(2), { field: 'budget', op: 'gt', value: 5_000_000 }),
    ],
    ['Больше 10 сотрудников', and({ field: 'headcount', op: 'gt', value: 10 })],
    [
      'Дивизионы с бюджетом не более 1,5 млрд рублей',
      and(level(1), { field: 'budget', op: 'lte', value: 1_500_000_000 }),
    ],
    ['Бюджет >= 500 тыс. руб.', and({ field: 'budget', op: 'gte', value: 500_000 })],
    [
      'Команды с бюджетом выше 1 500 000 и численностью меньше 20',
      and(
        level(3),
        { field: 'budget', op: 'gt', value: 1_500_000 },
        { field: 'headcount', op: 'lt', value: 20 },
      ),
    ],
    ['Команды без сотрудников', and(level(3), { field: 'headcount', op: 'eq', value: 0 })],
    ['Подразделения без бюджета', and({ field: 'budget', op: 'eq', value: 0 })],
    ['Отделы', and(level(2))],
    ['Не команды', and({ field: 'level', op: 'ne', value: 3 })],
    [
      'Команды с эффективностью не равной 80%',
      and(level(3), { field: 'performance', op: 'ne', value: 80 }),
    ],
    ['Численность != 10', and({ field: 'headcount', op: 'ne', value: 10 })],
    [
      'Команды с численностью от 10 до 20',
      and(
        level(3),
        { field: 'headcount', op: 'gte', value: 10 },
        { field: 'headcount', op: 'lte', value: 20 },
      ),
    ],
    [
      'От 10 до 20 сотрудников',
      and(
        { field: 'headcount', op: 'gte', value: 10 },
        { field: 'headcount', op: 'lte', value: 20 },
      ),
    ],
    [
      'Бюджет от 1 до 2 млн',
      and(
        { field: 'budget', op: 'gte', value: 1_000_000 },
        { field: 'budget', op: 'lte', value: 2_000_000 },
      ),
    ],
    [
      'Бюджет от 500 тыс до 2 млн',
      and(
        { field: 'budget', op: 'gte', value: 500_000 },
        { field: 'budget', op: 'lte', value: 2_000_000 },
      ),
    ],
    [
      'Эффективность выше 60% и ниже 80%',
      and(
        { field: 'performance', op: 'gt', value: 60 },
        { field: 'performance', op: 'lt', value: 80 },
      ),
    ],
    ['Численность больше или равно 15', and({ field: 'headcount', op: 'gte', value: 15 })],
    [
      'Команды кроме разработки',
      and(level(3), { field: 'name', op: 'notContains', value: 'разработки' }),
    ],
    [
      'Отделы с названием "Продажи и маркетинг"',
      and(level(2), { field: 'name', op: 'contains', value: 'продажи и маркетинг' }),
    ],
    [
      'Название не содержит «разработка или поддержка»',
      and({ field: 'name', op: 'notContains', value: 'разработка или поддержка' }),
    ],
    [
      'Выбери три отдела с самым большим бюджетом',
      { ...and(level(2)), sort: { field: 'budget', direction: 'desc' }, limit: 3 },
    ],
    [
      'Топ 5 отделов с наименьшим бюджетом',
      { ...and(level(2)), sort: { field: 'budget', direction: 'asc' }, limit: 5 },
    ],
    [
      'Покажи 2 команды с самой высокой эффективностью',
      { ...and(level(3)), sort: { field: 'performance', direction: 'desc' }, limit: 2 },
    ],
    [
      'Самые эффективные команды',
      { ...and(level(3)), sort: { field: 'performance', direction: 'desc' } },
    ],
    [
      'Отделы по бюджету по убыванию',
      { ...and(level(2)), sort: { field: 'budget', direction: 'desc' } },
    ],
    [
      'Отсортируй по названию по возрастанию',
      { ...emptySearchFilter(), sort: { field: 'name', direction: 'asc' } },
    ],
    ['Выбери три подразделения', { ...emptySearchFilter(), limit: 3 }],
    [
      'Команды с эффективностью ниже 80% или бюджетом больше 5 млн',
      {
        ...emptySearchFilter(),
        groups: [below80.groups[0], [level(3), { field: 'budget', op: 'gt', value: 5_000_000 }]],
      },
    ],
    ['Отделы или команды', { ...emptySearchFilter(), groups: [[level(2)], [level(3)]] }],
  ])('preserves all requested semantics: %s', (query, expected) => {
    expect(parseLocalSearch(query as string)).toEqual(expected);
  });

  it.each([
    ['Все подразделения кроме команд', 3],
    ['Все подразделения кроме дивизионов', 1],
  ] as const)('excludes a bare hierarchy type rather than its name: %s', (query, value) => {
    expect(parseLocalSearch(query)).toEqual(and({ field: 'level', op: 'ne', value }));
  });

  it('keeps excluded departments out of the highest-budget top N', () => {
    expect(
      parseLocalSearch('Выбери два подразделения кроме отделов с самым большим бюджетом'),
    ).toEqual({
      ...and({ field: 'level', op: 'ne', value: 2 }),
      sort: { field: 'budget', direction: 'desc' },
      limit: 2,
    });
  });

  it.each(['«Команд»', '"Команд"'])(
    'preserves a quoted type word as a literal excluded name: %s',
    (name) => {
      expect(parseLocalSearch(`Все подразделения кроме ${name}`)).toEqual(
        and({ field: 'name', op: 'notContains', value: 'команд' }),
      );
    },
  );

  it.each([
    ['Бюджет от 1 млн до 2000000 руб', 1_000_000, 2_000_000],
    ['Бюджет от 500000 рублей до 2 млн', 500_000, 2_000_000],
  ])('keeps each explicit range unit independent: %s', (query, lower, upper) => {
    expect(parseLocalSearch(query as string)).toEqual(
      and(
        { field: 'budget', op: 'gte', value: lower as number },
        { field: 'budget', op: 'lte', value: upper as number },
      ),
    );
  });

  it.each(['подразделения', 'все подразделения'])(
    'does not inherit a hierarchy restriction into an explicit %s OR branch',
    (subject) => {
      const query = `Команды с бюджетом больше 5 млн или ${subject} с численностью меньше 10`;
      expect(parseLocalSearch(query)).toEqual({
        ...emptySearchFilter(),
        groups: [
          [level(3), { field: 'budget', op: 'gt', value: 5_000_000 }],
          [{ field: 'headcount', op: 'lt', value: 10 }],
        ],
      });
    },
  );

  it.each([
    'Команды с эффективностью ниже 80% и офисом в Москве',
    'Команды с бюджетом больше -5 млн',
    'Отделы с бюджетом больше 5 млн долларов',
    'Бюджет выше 9999999999999999999999999999999',
    'Команды с эффективностью ниже 80% за прошлый месяц',
    'Отделы с бюджетом > 5 млн кроме продаж',
    'Больше 10 сотрудников со стажем больше 3 лет',
    'Выбери три отдела с самым большим бюджетом за прошлый месяц',
    'Топ 3 отдела',
    'Численность от 20 до 10',
    'Отделы или',
    'Команды с бюджетом меньше 5 млн и офисом в Москве или отделы',
    'Команды кроме «Разработка» за прошлый месяц',
    'Команды кроме разработки с офисом в Москве',
    'Выбери 1001 отдела',
    Array.from({ length: 9 }, () => 'отделы').join(' или '),
    `Отделы с ${Array.from({ length: 8 }, () => 'бюджетом больше 0').join(' и ')}`,
    'Название содержит \u00010\u0002',
    'Найди',
  ])('never drops an unknown, oversized or incomplete clause: %s', (query) => {
    expect(parseLocalSearch(query)).toBeNull();
  });

  it('honestly reports local parsing without calling a model, even when a key is present', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(
      await resolveSearch('Команды с эффективностью ниже 80%', { env: {}, fetch }),
    ).toMatchObject({ source: 'local', filter: below80 });
    expect(
      await resolveSearch('Выбери три отдела с самым большим бюджетом', {
        env: { SEARCH_PROVIDER: 'local', AI_API_KEY: 'unused-secret' },
        fetch,
      }),
    ).toMatchObject({
      source: 'local',
      filter: { ...and(level(2)), sort: { field: 'budget', direction: 'desc' }, limit: 3 },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retains the complete original query in the literal fallback', async () => {
    const query = 'Команды с эффективностью ниже 80% и офисом в Москве';
    expect(await resolveSearch(query, { env: {} })).toMatchObject({
      source: 'text',
      filter: and({ field: 'name', op: 'contains', value: query }),
    });
  });
});
