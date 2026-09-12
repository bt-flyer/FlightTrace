import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

test('imports a log when a deployment has removed standalone parser assets', async ({ page }) => {
  // An already-open page can outlive the hashed worker file from its deployment.
  await page.route(/\/assets\/[^/]+\.worker-[^/]+\.js(?:\?.*)?$/, (route) => route.fulfill({ status: 404, contentType: 'text/html', body: 'File not found' }))
  await page.goto('/')
  await page.locator('input[type="file"][accept*="csv"]').setInputFiles({
    name: 'PARSER-UPDATE-2026-06-01-12-00-00.csv', mimeType: 'text/csv',
    buffer: Buffer.from('Date,Time,VFR(%)\n2026-06-01,12:00:00.000,100\n2026-06-01,12:00:01.000,90')
  })
  await expect(page.getByRole('heading', { name: 'Set up this plane' })).toBeVisible()
  for (let step = 0; step < 3; step += 1) await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Save plane and import' }).click()
  await expect(page.getByText(/Imported PARSER-UPDATE/)).toBeVisible()
  await page.getByRole('link', { name: /PARSER-UPDATE.*Open flight library/ }).click()
  await page.locator('.log-main').click()
  await expect(page.getByRole('heading', { name: 'Telemetry channels' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})
