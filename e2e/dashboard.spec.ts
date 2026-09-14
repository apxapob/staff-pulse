import { test, expect } from '@playwright/test';

test('loads hierarchy and expands the second level by default', async ({page})=>{
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Структура компании'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Свернуть Разработка',exact:true})).toHaveAttribute('aria-expanded','true');
  await expect(page.getByRole('button',{name:/^Веб-платформа/})).toBeVisible();
  await page.getByRole('button',{name:'Свернуть Технологии',exact:true}).click();
  await expect(page.getByRole('button',{name:/^Веб-платформа/})).not.toBeVisible();
  await expect(page.locator('[style]')).toHaveCount(0);
});

test('shows loading followed by an empty state', async ({page})=>{
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/org-tree', async route=>{await gate; await route.fulfill({json:[]});});
  await page.goto('/');
  await expect(page.getByRole('status')).toBeVisible();
  release();
  await expect(page.getByRole('heading',{name:'Пока нет подразделений'})).toBeVisible();
});

test('invalid hierarchy becomes a recoverable error', async ({page})=>{
  await page.route('**/api/org-tree',route=>route.fulfill({json:[{id:'invalid'}]}));
  await page.goto('/');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.unroute('**/api/org-tree');
  await page.getByRole('button',{name:'Попробовать ещё раз'}).click();
  await expect(page.getByRole('heading',{name:'Структура компании'})).toBeVisible();
});

test('aggregates, sorts, filters and selects the corresponding tree node', async ({page})=>{
  await page.goto('/');
  const row=page.locator('tr[data-node-id="development"]');
  await expect(row.locator('td').nth(2)).toHaveText('40');
  await page.getByRole('button',{name:'Всего сотрудников',exact:true}).dblclick();
  await expect(page.getByRole('columnheader',{name:'Всего сотрудников'})).toHaveAttribute('aria-sort','descending');
  await page.getByRole('button',{name:'Свернуть Технологии',exact:true}).click();
  await page.getByRole('textbox',{name:'Поиск подразделения'}).fill('Веб-платформа');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.locator('tbody tr').click();
  await expect(page.getByRole('button',{name:/^Веб-платформа/})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'Очистить поиск'}).click();
  await page.getByLabel('Уровень подразделения').selectOption('1');
  await expect(page.locator('tbody tr')).toHaveCount(6);
});

test('mobile view switches between the table and tree without overflow', async ({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Аналитика подразделений'})).toBeVisible();
  await page.getByRole('button',{name:'Дерево',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Структура компании'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
