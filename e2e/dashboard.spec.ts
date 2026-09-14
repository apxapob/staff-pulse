import { test, expect } from '@playwright/test';
import { orgTreeSeed } from '../server/data';

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
