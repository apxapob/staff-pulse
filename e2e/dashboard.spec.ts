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

