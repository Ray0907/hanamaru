import { expect, test } from '@playwright/test';

test('harness heading is visible', async ({ page }) => {
  await page.goto('/tests/fixtures/harness.html');
  await expect(page.getByRole('heading', { name: 'Hanamaru harness' })).toBeVisible();
});
