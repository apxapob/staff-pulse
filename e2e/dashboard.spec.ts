import { test, expect } from '@playwright/test';
import { orgTreeSeed } from '../server/data';
import { emptySearchFilter } from '../src/search/filter';
import type { SearchStatus } from '../src/search/status';

test('loads hierarchy and expands the second level by default', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Структура компании' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Свернуть Разработка', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: /^Веб-платформа/ })).toBeVisible();
  await page.getByRole('button', { name: 'Свернуть Технологии', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Веб-платформа/ })).not.toBeVisible();
  await expect(page.locator('[style]')).toHaveCount(0);
});

test('lists direct employees separately from descendants without double-counting totals', async ({
  page,
}) => {
  await page.route('**/api/org-tree', (route) => route.fulfill({ json: orgTreeSeed }));
  await page.goto('/');

  for (const id of ['technology', 'development']) {
    const node = orgTreeSeed.find((entry) => entry.id === id)!;
    const roster = page.getByRole('list', { name: `Сотрудники ${node.name}`, exact: true });
    await expect(roster.locator('li[data-employee-id]')).toHaveCount(node.headcount);
    for (const employee of node.employees!) {
      const row = roster.locator(`[data-employee-id="${employee.id}"]`);
      await expect(row).toContainText(employee.name);
      await expect(row).toContainText(employee.role);
    }
    await expect(roster.getByRole('button')).toHaveCount(0);
  }

  await expect(page.locator('#org-node-technology')).toHaveText('Технологии74');
  await expect(page.locator('#org-node-development')).toHaveText('Разработка40');
  await expect(page.locator('tr[data-node-id="technology"] td').nth(2)).toHaveText('74');
  await expect(page.locator('tr[data-node-id="development"] td').nth(2)).toHaveText('40');
  await expect(page.locator('tbody tr')).toHaveCount(orgTreeSeed.length);
  const employeeTotal = orgTreeSeed.reduce((total, node) => total + node.headcount, 0);
  await expect(
    page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Всего сотрудников', exact: true }) })
      .locator('strong'),
  ).toHaveText(String(employeeTotal));
});

test('expands a team to its employees with the keyboard and hides them on collapse', async ({
  page,
}) => {
  await page.route('**/api/org-tree', (route) => route.fulfill({ json: orgTreeSeed }));
  await page.goto('/');
  const team = orgTreeSeed.find((node) => node.id === 'frontend')!;
  const roster = page.getByRole('list', { name: `Сотрудники ${team.name}`, exact: true });
  const expand = page.getByRole('button', { name: `Раскрыть ${team.name}`, exact: true });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expect(roster).not.toBeVisible();
  await expand.focus();
  await page.keyboard.press('Enter');
  await expect(roster.locator('li[data-employee-id]')).toHaveCount(team.headcount);
  await expect(roster).toContainText(team.employees![0].name);
  await expect(roster.getByRole('button')).toHaveCount(0);
  await expect(page.locator('#org-node-frontend')).toHaveAttribute('aria-pressed', 'false');

  const collapse = page.getByRole('button', { name: `Свернуть ${team.name}`, exact: true });
  await expect(collapse).toBeFocused();
  await page.keyboard.press('Space');
  await expect(roster).not.toBeVisible();
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('tbody tr')).toHaveCount(orgTreeSeed.length);
});

test('opens an empty team without creating placeholder employees', async ({ page }) => {
  const nodes = orgTreeSeed.map((node) =>
    node.id === 'frontend' ? { ...node, headcount: 0, employees: [] } : node,
  );
  await page.route('**/api/org-tree', (route) => route.fulfill({ json: nodes }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Раскрыть Веб-платформа', exact: true }).click();
  await expect(
    page.getByText('В подразделении пока нет сотрудников', { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('list', { name: 'Сотрудники Веб-платформа', exact: true })
      .locator('li[data-employee-id]'),
  ).toHaveCount(0);
  await expect(page.locator('#org-node-frontend')).toHaveText('Веб-платформа0');
  await expect(page.locator('tr[data-node-id="frontend"] td').nth(2)).toHaveText('0');
});

test('applies a live employee addition to the roster and totals while preserving expansion', async ({
  page,
}) => {
  const team = orgTreeSeed.find((node) => node.id === 'frontend')!;
  const employee = { id: 'frontend-e2e-new', name: 'Мария Тестовая', role: 'Разработчик' };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let snapshotRequests = 0;
  let streamRequests = 0;
  await page.route('**/api/org-tree', (route) => {
    snapshotRequests++;
    return route.fulfill({ json: orgTreeSeed, headers: { 'X-Org-Cursor': 'employees-e2e:0' } });
  });
  await page.route('**/api/org-events?**', async (route) => {
    streamRequests++;
    if (streamRequests > 1) return route.fulfill({ status: 204 });
    await gate;
    const patch = {
      previousCursor: 'employees-e2e:0',
      cursor: 'employees-e2e:1',
      changes: [
        {
          id: team.id,
          headcount: team.headcount + 1,
          employees: [...team.employees!, employee],
          updatedAt: '2026-09-14T10:00:00.000Z',
        },
      ],
    };
    await route.fulfill({
      contentType: 'text/event-stream',
      body: `event: ready\ndata: ${JSON.stringify({ cursor: 'employees-e2e:0' })}\n\nevent: patch\ndata: ${JSON.stringify(patch)}\n\n`,
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Раскрыть Веб-платформа', exact: true }).click();
  await page.getByRole('button', { name: 'Свернуть Обеспечение качества', exact: true }).click();
  const roster = page.getByRole('list', { name: 'Сотрудники Веб-платформа', exact: true });
  await expect(roster.locator('li[data-employee-id]')).toHaveCount(12);
  const snapshotsBeforePatch = snapshotRequests;
  release();
  await expect(roster.locator('li[data-employee-id]')).toHaveCount(13);
  await expect(roster).toContainText(employee.name);
  await expect(page.locator('#org-node-frontend')).toHaveText('Веб-платформа13');
  await expect(page.locator('#org-node-development')).toHaveText('Разработка41');
  await expect(page.locator('#org-node-technology')).toHaveText('Технологии75');
  await expect(page.locator('tr[data-node-id="frontend"] td').nth(2)).toHaveText('13');
  await expect(page.locator('tr[data-node-id="development"] td').nth(2)).toHaveText('41');
  await expect(
    page.getByRole('button', { name: 'Свернуть Веб-платформа', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.getByRole('button', { name: 'Раскрыть Обеспечение качества', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('tbody tr')).toHaveCount(orgTreeSeed.length);
  expect(snapshotRequests).toBe(snapshotsBeforePatch);
});

test('shows loading followed by an empty state', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/org-tree', async (route) => {
    await gate;
    await route.fulfill({ json: [] });
  });
  await page.goto('/');
  await expect(page.getByRole('status', { name: 'Загрузка данных' })).toBeVisible();
  release();
  await expect(page.getByRole('heading', { name: 'Пока нет подразделений' })).toBeVisible();
});

test('invalid hierarchy becomes a recoverable error', async ({ page }) => {
  await page.route('**/api/org-tree', (route) => route.fulfill({ json: [{ id: 'invalid' }] }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.unroute('**/api/org-tree');
  await page.getByRole('button', { name: 'Попробовать ещё раз' }).click();
  await expect(page.getByRole('heading', { name: 'Структура компании' })).toBeVisible();
});

test('aggregates, sorts, filters and selects the corresponding tree node', async ({ page }) => {
  await page.route('**/api/org-tree', (route) => route.fulfill({ json: orgTreeSeed }));
  await page.goto('/');
  const row = page.locator('tr[data-node-id="development"]');
  await expect(row.locator('td').nth(2)).toHaveText('40');
  await page.getByRole('button', { name: 'Всего сотрудников', exact: true }).dblclick();
  await expect(page.getByRole('columnheader', { name: 'Всего сотрудников' })).toHaveAttribute(
    'aria-sort',
    'descending',
  );
  await page.getByRole('button', { name: 'Свернуть Технологии', exact: true }).click();
  await page.getByRole('textbox', { name: 'Поиск подразделения' }).fill('Веб-платформа');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.locator('tbody tr').click();
  await expect(page.getByRole('button', { name: /^Веб-платформа/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Очистить поиск' }).click();
  await page.getByRole('button', { name: 'Свернуть Технологии', exact: true }).click();
  await page.locator('tr[data-node-id="frontend"]').click();
  await expect(
    page.getByRole('button', { name: 'Свернуть Технологии', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await page.getByLabel('Уровень подразделения').selectOption('1');
  await expect(page.locator('tbody tr')).toHaveCount(6);
});

test('mobile view switches between the table and tree without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Аналитика подразделений' })).toBeVisible();
  await page.getByRole('button', { name: 'Дерево', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Структура компании' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('supports row keyboard navigation and respects reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const rows = page.locator('tbody tr');
  await rows.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(rows.last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[style]')).toHaveCount(0);
  const durations = await page
    .locator('section[aria-label="Организационная структура"] div[aria-hidden]')
    .evaluateAll((elements) => elements.map((el) => getComputedStyle(el).transitionDuration));
  expect(durations.every((value) => parseFloat(value) <= 0.001)).toBe(true);
});

test('receives live patches and reconnects without another tree snapshot', async ({
  page,
  context,
}) => {
  test.setTimeout(25_000);
  let snapshotRequests = 0;
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/org-tree') snapshotRequests++;
  });
  await page.goto('/');
  await expect(page.getByRole('status', { name: 'Статус соединения' })).toHaveText(
    'Обновляется в реальном времени',
  );
  const baseline = snapshotRequests;
  await expect
    .poll(() => page.locator('td[data-flash="true"]').count(), { timeout: 12_000 })
    .toBeGreaterThan(0);
  expect(snapshotRequests).toBe(baseline);
  const changedCell = page.locator('td[data-flash="true"]').first();
  expect(await changedCell.evaluate((el) => getComputedStyle(el).animationDuration)).toBe('1.5s');
  await expect
    .poll(() => changedCell.evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe('rgba(0, 0, 0, 0)');
  await context.setOffline(true);
  await expect(page.getByRole('status', { name: 'Статус соединения' })).toHaveText(
    'Нет соединения',
  );
  await context.setOffline(false);
  await expect(page.getByRole('status', { name: 'Статус соединения' })).toHaveText(
    'Обновляется в реальном времени',
  );
  expect(snapshotRequests).toBe(baseline);
});

test('recovers a rejected cursor with one fresh snapshot and opens a new stream', async ({
  page,
}) => {
  let recoveryStarted = false;
  let freshSnapshots = 0;
  await page.route('**/api/org-events?**', async (route) => {
    if (route.request().url().includes('expired-instance')) recoveryStarted = true;
    await route.continue();
  });
  await page.route('**/api/org-tree', async (route) => {
    const response = await route.fetch();
    if (recoveryStarted) {
      freshSnapshots++;
      await route.fulfill({ response });
    } else
      await route.fulfill({
        response,
        headers: { ...response.headers(), 'x-org-cursor': 'expired-instance:0' },
      });
  });
  await page.goto('/');
  await expect(page.getByRole('status', { name: 'Статус соединения' })).toHaveText(
    'Обновляется в реальном времени',
    { timeout: 10_000 },
  );
  expect(recoveryStarted).toBe(true);
  expect(freshSnapshots).toBe(1);
});

test('applies a structured natural-language filter on client aggregates', async ({ page }) => {
  await page.route('**/api/org-tree', (route) => route.fulfill({ json: orgTreeSeed }));
  await page.route('**/api/search', (route) => {
    expect(route.request().postDataJSON()).toEqual({ query: 'Команды с эффективностью ниже 80%' });
    return route.fulfill({
      json: {
        filter: {
          ...emptySearchFilter(),
          groups: [
            [
              { field: 'level', op: 'eq', value: 3 },
              { field: 'performance', op: 'lt', value: 80 },
            ],
          ],
        },
        source: 'local',
        explanation: 'Фраза распознана локально, без обращения к AI.',
      },
    });
  });
  await page.goto('/');
  await page
    .getByRole('textbox', { name: 'Поиск подразделения' })
    .fill('Команды с эффективностью ниже 80%');
  await expect(page.getByRole('button', { name: 'Умный поиск', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Поиск подразделения' }).press('Enter');
  await expect(page.getByRole('status', { name: 'Результат умного поиска' })).toContainText(
    'Эффективность < 80%',
  );
  const expected = orgTreeSeed.filter(
    (node) => node.performance < 80 && !orgTreeSeed.some((child) => child.parentId === node.id),
  ).length;
  await expect(page.locator('tbody tr')).toHaveCount(expected);
  await page.getByRole('button', { name: 'Сбросить умный фильтр' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(52);
});

test('selects top three after the level facet, preserves membership on manual sorting and reranks a live patch', async ({
  page,
}) => {
  const budgetById: Record<string, number> = {
    frontend: 30_000_000,
    backend: 20_000_000,
    mobile: 10_000_000,
  };
  const nodes = orgTreeSeed.map((node) =>
    budgetById[node.id] ? { ...node, budget: budgetById[node.id] } : node,
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let streamRequests = 0;
  let snapshotRequests = 0;
  let searchRequests = 0;
  await page.route('**/api/org-tree', (route) => {
    snapshotRequests++;
    return route.fulfill({ json: nodes, headers: { 'X-Org-Cursor': 'top-three-e2e:0' } });
  });
  await page.route('**/api/org-events?**', async (route) => {
    if (++streamRequests > 1) return route.fulfill({ status: 204 });
    await gate;
    const patch = {
      previousCursor: 'top-three-e2e:0',
      cursor: 'top-three-e2e:1',
      changes: [{ id: 'devops', budget: 40_000_000, updatedAt: '2026-09-15T10:00:00.000Z' }],
    };
    await route.fulfill({
      contentType: 'text/event-stream',
      body: `event: ready\ndata: ${JSON.stringify({ cursor: 'top-three-e2e:0' })}\n\nevent: patch\ndata: ${JSON.stringify(patch)}\n\n`,
    });
  });
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/search') searchRequests++;
  });
  await page.goto('/');
  await page.getByLabel('Уровень подразделения').selectOption('3');
  const input = page.getByRole('textbox', { name: 'Поиск подразделения' });
  await input.fill('Выбери три подразделения с самым большим бюджетом');
  await expect(page.getByRole('button', { name: 'Умный поиск', exact: true })).toBeEnabled();
  const response = page.waitForResponse(
    (result) => new URL(result.url()).pathname === '/api/search',
  );
  await input.press('Enter');
  expect((await (await response).json()).source).toBe('local');
  const result = page.getByRole('status', { name: 'Результат умного поиска' });
  await expect(result).toContainText('Бюджет, по убыванию');
  await expect(result).toContainText('Первые 3');
  const ids = () =>
    page
      .locator('tbody tr')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-node-id')));
  await expect.poll(ids).toEqual(['frontend', 'backend', 'mobile']);
  await expect(page.getByRole('columnheader', { name: 'Бюджет суммарный' })).toHaveAttribute(
    'aria-sort',
    'descending',
  );
  await page.getByRole('button', { name: 'Всего сотрудников', exact: true }).dblclick();
  await expect.poll(ids).toEqual(['backend', 'frontend', 'mobile']);
  const snapshotsBeforePatch = snapshotRequests;
  release();
  await expect.poll(ids).toEqual(['backend', 'frontend', 'devops']);
  await expect(page.getByRole('columnheader', { name: 'Всего сотрудников' })).toHaveAttribute(
    'aria-sort',
    'descending',
  );
  await expect(result).toContainText('Бюджет, по убыванию');
  expect(snapshotRequests).toBe(snapshotsBeforePatch);
  expect(searchRequests).toBe(1);
  await page.getByRole('button', { name: 'Сбросить умный фильтр' }).click();
  await expect(page.locator('tbody tr')).not.toHaveCount(3);
});

test('shows OR groups, range bounds, not-equal and name exclusions in the applied filter', async ({
  page,
}) => {
  await page.route('**/api/org-tree', (route) => route.fulfill({ json: orgTreeSeed }));
  await page.route('**/api/search', (route) =>
    route.fulfill({
      json: {
        filter: {
          ...emptySearchFilter(),
          groups: [
            [
              { field: 'name', op: 'contains', value: 'разработка' },
              { field: 'name', op: 'notContains', value: 'серверная' },
            ],
            [
              { field: 'level', op: 'eq', value: 3 },
              { field: 'headcount', op: 'gte', value: 9 },
              { field: 'headcount', op: 'lte', value: 12 },
              { field: 'performance', op: 'ne', value: 93 },
            ],
          ],
        },
        source: 'local',
        explanation: 'Составные условия',
      },
    }),
  );
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Поиск подразделения' }).fill('Составной запрос');
  await page.getByRole('button', { name: 'Умный поиск', exact: true }).click();
  const result = page.getByRole('status', { name: 'Результат умного поиска' });
  await expect(result).toContainText('Название не содержит «серверная»');
  await expect(result).toContainText('ИЛИ');
  await expect(result).toContainText('Сотрудники ≥ 9 И Сотрудники ≤ 12 И Эффективность ≠ 93%');
  await expect(page.locator('tr[data-node-id="development"]')).toBeVisible();
  await expect(page.locator('tr[data-node-id="mobile"]')).toBeVisible();
  await expect(page.locator('tr[data-node-id="backend"]')).toHaveCount(0);
  await expect(page.locator('tr[data-node-id="frontend"]')).toHaveCount(0);
});

test('falls back to text on invalid search response and discards an outdated request', async ({
  page,
}) => {
  await page.route('**/api/org-tree', (route) => route.fulfill({ json: orgTreeSeed }));
  await page.route('**/api/search', (route) => route.fulfill({ json: { filter: { sql: 'bad' } } }));
  await page.goto('/');
  const input = page.getByRole('textbox', { name: 'Поиск подразделения' });
  await input.fill('Веб-платформа');
  await page.getByRole('button', { name: 'Умный поиск', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Результат умного поиска' })).toContainText(
    'Текстовый поиск',
  );
  await expect(page.locator('tbody tr')).toHaveCount(1);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.unroute('**/api/search');
  await page.route('**/api/search', async (route) => {
    await gate;
    await route.fulfill({
      json: {
        filter: { ...emptySearchFilter(), groups: [[{ field: 'level', op: 'eq', value: 1 }]] },
        source: 'ai',
        explanation: 'Устаревший ответ',
      },
    });
  });
  await input.fill('Все дивизионы');
  await page.getByRole('button', { name: 'Умный поиск', exact: true }).click();
  await input.fill('Бухгалтерия');
  release();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr')).toContainText('Бухгалтерия');
  await expect(page.getByRole('status', { name: 'Результат умного поиска' })).toHaveCount(0);
});

test.describe('smart search availability', () => {
  test('checks, downloads and warms automatically while ordinary search and live data stay usable', async ({
    page,
  }) => {
    let phase: SearchStatus['status'] = 'downloading';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let posts = 0;
    await page.route('**/api/search/status', async (route) => {
      await gate;
      if (!route.request().failure()) await route.fulfill({ json: { status: phase } });
    });
    await page.route('**/api/search', (route) => {
      posts++;
      return route.fulfill({ status: 500 });
    });
    try {
      await page.goto('/');
      const button = page.getByRole('button', { name: 'Умный поиск', exact: true });
      const wrapper = page.getByRole('group', { name: 'Доступность умного поиска' });
      const tooltip = page.getByRole('tooltip');
      const input = page.getByRole('textbox', { name: 'Поиск подразделения' });
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute('aria-busy', 'true');
      await page.getByLabel('Уровень подразделения').focus();
      await page.keyboard.press('Tab');
      await expect(wrapper).toBeFocused();
      await expect(tooltip).toContainText('Проверяем готовность');
      await expect(wrapper).toHaveAttribute(
        'aria-describedby',
        (await tooltip.getAttribute('id')) ?? '',
      );
      await page.keyboard.press('Escape');
      await expect(tooltip).not.toBeVisible();
      await input.fill('Веб-платформа');
      await expect(page.locator('tbody tr')).toHaveCount(1);
      await expect(page.locator('tbody tr')).toContainText('Веб-платформа');
      await input.press('Enter');
      await button.click({ force: true });
      expect(posts).toBe(0);
      release();
      await wrapper.hover();
      await expect(tooltip).toContainText('Скачиваем локальную модель');
      await expect(page.getByRole('status', { name: 'Статус соединения' })).toHaveText(
        'Обновляется в реальном времени',
      );
      await page.getByRole('button', { name: 'Свернуть Технологии', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Раскрыть Технологии', exact: true }),
      ).toHaveAttribute('aria-expanded', 'false');
      phase = 'warming';
      await wrapper.focus();
      await expect(tooltip).toContainText('Прогреваем локальную модель', { timeout: 6_000 });
      await expect(button).toBeDisabled();
      phase = 'ready';
      await expect(button).toBeEnabled({ timeout: 6_000 });
      await expect(button).toHaveAttribute('aria-busy', 'false');
      expect(posts).toBe(0);
      await input.fill('   ');
      await input.press('Enter');
      await button.click({ force: true });
      expect(posts).toBe(0);
    } finally {
      release();
    }
  });

  test('explains preparation errors and recovers automatically with a mobile keyboard tooltip', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    let phase: SearchStatus['status'] = 'error';
    let posts = 0;
    await page.route('**/api/search/status', (route) => route.fulfill({ json: { status: phase } }));
    await page.route('**/api/search', (route) => {
      posts++;
      return route.fulfill({ status: 500 });
    });
    await page.goto('/');
    const button = page.getByRole('button', { name: 'Умный поиск', exact: true });
    const wrapper = page.getByRole('group', { name: 'Доступность умного поиска' });
    const tooltip = page.getByRole('tooltip');
    const input = page.getByRole('textbox', { name: 'Поиск подразделения' });
    await input.fill('Бухгалтерия');
    await wrapper.focus();
    await expect(tooltip).toContainText('Повторите команду запуска');
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('aria-busy', 'false');
    await expect(button.locator('svg[data-loading]')).toHaveCount(0);
    const geometry = await tooltip.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const panel = element.closest('section')!.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        panelLeft: panel.left,
        panelRight: panel.right,
        viewport: innerWidth,
      };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.panelLeft);
    expect(geometry.right).toBeLessThanOrEqual(Math.min(geometry.panelRight, geometry.viewport));
    expect(await button.evaluate((element) => element.getBoundingClientRect().height)).toBe(37);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await input.press('Enter');
    await button.click({ force: true });
    expect(posts).toBe(0);
    await expect(page.locator('tbody tr')).toHaveCount(1);
    phase = 'unavailable';
    await wrapper.hover();
    await expect(tooltip).toContainText('временно недоступен', { timeout: 6_000 });
    phase = 'preparing';
    await expect(button).toHaveAttribute('aria-busy', 'true', { timeout: 6_000 });
    expect(
      await button
        .locator('svg[data-loading]')
        .evaluate((element) => getComputedStyle(element).animationName),
    ).toBe('none');
    phase = 'ready';
    await expect(button).toBeEnabled({ timeout: 6_000 });
    await expect(button).toHaveAttribute('aria-busy', 'false');
    expect(posts).toBe(0);
  });

  test('bounds a stalled status request and resumes polling instead of spinning forever', async ({
    page,
  }) => {
    let stall = true;
    const releases: (() => void)[] = [];
    await page.route('**/api/search/status', async (route) => {
      if (stall) {
        await new Promise<void>((resolve) => releases.push(resolve));
        await route.abort().catch(() => {});
      } else await route.fulfill({ json: { status: 'ready' } });
    });
    try {
      await page.goto('/');
      const button = page.getByRole('button', { name: 'Умный поиск', exact: true });
      await page.getByRole('textbox', { name: 'Поиск подразделения' }).fill('Бухгалтерия');
      await page.getByRole('group', { name: 'Доступность умного поиска' }).focus();
      await expect(button).toHaveAttribute('aria-busy', 'true');
      await expect(page.getByRole('tooltip')).toContainText('временно недоступен', {
        timeout: 8_000,
      });
      await expect(button).toHaveAttribute('aria-busy', 'false');
      await expect(page.locator('tbody tr')).toHaveCount(1);
      stall = false;
      releases.forEach((release) => release());
      await expect(button).toBeEnabled({ timeout: 6_000 });
    } finally {
      releases.forEach((release) => release());
    }
  });

  test('aborts the availability request and stops polling when analytics unmounts after resync', async ({
    page,
  }) => {
    await page.clock.install();
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const releases: (() => void)[] = [];
    let empty = false;
    let statusRequests = 0;
    await page.route('**/api/org-tree', (route) =>
      route.fulfill({
        json: empty ? [] : orgTreeSeed,
        headers: { 'X-Org-Cursor': `status-unmount:${empty ? 1 : 0}` },
      }),
    );
    await page.route('**/api/org-events?**', async (route) => {
      if (empty) return route.fulfill({ status: 204 });
      await streamGate;
      if (!route.request().failure())
        await route.fulfill({
          contentType: 'text/event-stream',
          body: 'event: resync\ndata: {}\n\n',
        });
    });
    await page.route('**/api/search/status', async (route) => {
      statusRequests++;
      await new Promise<void>((resolve) => releases.push(resolve));
      await route.abort().catch(() => {});
    });
    try {
      await page.goto('/');
      await expect(page.locator('tbody tr')).toHaveCount(orgTreeSeed.length);
      await expect.poll(() => statusRequests).toBeGreaterThan(0);
      const aborted = page.waitForEvent('requestfailed', {
        predicate: (request) => new URL(request.url()).pathname === '/api/search/status',
      });
      empty = true;
      releaseStream();
      await expect(page.getByRole('heading', { name: 'Пока нет подразделений' })).toBeVisible();
      await aborted;
      const before = statusRequests;
      releases.forEach((release) => release());
      await page.clock.fastForward(20_000);
      expect(statusRequests).toBe(before);
    } finally {
      releaseStream();
      releases.forEach((release) => release());
    }
  });

  test('keeps an in-flight search result when a readiness poll changes phase', async ({ page }) => {
    await page.clock.install();
    let phase: SearchStatus['status'] = 'ready';
    let statusRequests = 0;
    let posts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/org-tree', (route) => route.fulfill({ json: orgTreeSeed }));
    await page.route('**/api/search/status', (route) => {
      statusRequests++;
      return route.fulfill({ json: { status: phase } });
    });
    await page.route('**/api/search', async (route) => {
      posts++;
      await gate;
      await route.fulfill({
        json: {
          filter: { ...emptySearchFilter(), groups: [[{ field: 'level', op: 'eq', value: 3 }]] },
          source: 'ai',
          explanation: 'Показаны команды.',
        },
      });
    });
    try {
      await page.goto('/');
      const input = page.getByRole('textbox', { name: 'Поиск подразделения' });
      const button = page.getByRole('button', { name: 'Умный поиск', exact: true });
      await input.fill('Покажи команды');
      await button.click();
      await expect.poll(() => posts).toBe(1);
      await expect(button).toHaveAttribute('aria-busy', 'true');
      phase = 'warming';
      const before = statusRequests;
      await page.clock.fastForward(15_000);
      await expect.poll(() => statusRequests).toBeGreaterThan(before);
      await page.getByRole('group', { name: 'Доступность умного поиска' }).focus();
      await expect(page.getByRole('tooltip')).toContainText('Обрабатываем поисковый запрос');
      await input.press('Enter');
      expect(posts).toBe(1);
      release();
      await expect(page.getByRole('status', { name: 'Результат умного поиска' })).toContainText(
        'AI-фильтр',
      );
      await expect(button).toBeDisabled();
      await page.getByRole('group', { name: 'Доступность умного поиска' }).focus();
      await expect(page.getByRole('tooltip')).toContainText('Прогреваем локальную модель');
    } finally {
      release();
    }
  });
});
