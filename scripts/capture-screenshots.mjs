import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const baseURL = process.argv[2] ?? 'http://localhost:8080';
await mkdir('docs/screenshots', { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
    deviceScaleFactor: 1,
  });
  await page.goto(baseURL);
  await page
    .getByRole('status', { name: 'Статус соединения' })
    .filter({ hasText: 'Обновляется в реальном времени' })
    .waitFor();
  await page.locator('tr[data-node-id="frontend"]').click();
  await page.getByRole('button', { name: 'Раскрыть Веб-платформа', exact: true }).click();
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== 'running'),
  );
  await page.screenshot({ path: 'docs/screenshots/desktop.png', fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Дерево', exact: true }).click();
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== 'running'),
  );
  await page.screenshot({ path: 'docs/screenshots/mobile.png', fullPage: true });
  console.info(`Captured production screenshots from ${baseURL}`);
} finally {
  await browser.close();
}
