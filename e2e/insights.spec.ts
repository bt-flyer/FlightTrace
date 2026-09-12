import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

test('reconstructs incidents, compares earlier flights, and reviews RF evidence locally', async ({ page }, testInfo) => {
  const externalRequests: string[] = []
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => { if (new URL(request.url()).origin !== 'http://127.0.0.1:4173') externalRequests.push(request.url()) })
  await page.goto('/')
  for (let day = 1; day <= 4; day += 1) {
    const rows = ['Timestamp,Throttle,RX1 VFR(%),RX2 VFR(%),ESC temperature(°C),Receiver voltage(V)']
    for (let second = 0; second <= 90; second += 1) {
      const timestamp = new Date(Date.UTC(2026, 5, day, 12, 0, second)).toISOString()
      rows.push([timestamp, second >= 5 && second < 85 ? 400 : -1024, day === 4 && second >= 20 && second < 25 ? 20 : 100, day === 4 && second >= 22 && second < 27 ? 20 : 100, day === 4 ? 75 : 40 + day - 2, 6.1].join(','))
    }
    await page.locator('input[type="file"][accept*="csv"]').setInputFiles({ name: `INSIGHTS-2026-06-0${day}-12-00-00.csv`, mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n')) })
    if (day === 1) {
      for (let step = 0; step < 3; step += 1) await page.getByRole('button', { name: 'Continue' }).click()
      await page.getByRole('button', { name: 'Save plane and import' }).click()
    }
    await expect(page.getByText(`Imported INSIGHTS-2026-06-0${day}-12-00-00.csv:`)).toBeVisible()
  }
  await page.getByRole('link', { name: /INSIGHTS.*Open flight library/ }).click()
  await page.locator('.log-main').first().click()
  await expect(page.getByRole('heading', { name: 'Incident review' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'RF redundancy', exact: true })).toBeVisible()
  await expect(page.getByText('Higher than usual', { exact: true })).toBeVisible()
  await expect(page.locator('.history-finding')).toContainText('75.00 °C now · 40.00 °C historical median')
  await page.getByText('Comparison evidence (4 signals)').click()
  await expect(page.locator('.history-details tbody tr').filter({ hasText: 'ESC temperature' })).toContainText('35.00 °C–45.00 °C')
  await expect(page.locator('.rf-metrics')).toContainText('3.0 s')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('flight-insights.png'), fullPage: true })
  await page.getByRole('region', { name: 'Compared with previous flights' }).screenshot({ path: testInfo.outputPath('history-panel.png') })
  await page.getByRole('region', { name: 'RF redundancy', exact: true }).screenshot({ path: testInfo.outputPath('rf-panel.png') })
  expect(errors).toEqual([])
  if (await page.getByText('Technical details', { exact: true }).isVisible()) {
    await page.getByText('Technical details', { exact: true }).click()
    throw new Error(await page.locator('main').innerText())
  }

  await page.getByRole('button', { name: 'Review episode 1', exact: true }).click()
  await expect(page.getByText('Reviewing episode', { exact: true })).toBeVisible()
  await expect(page.locator('.trace-focus-note')).toContainText('Review window +12.0–34.0 s')
  await page.getByRole('button', { name: 'Show full recording' }).click()
  await expect(page.locator('.trace-focus-note')).toHaveCount(0)
  await page.getByText('Simultaneous low episodes (1)').click()
  await page.getByRole('button', { name: 'Review RF episode', exact: true }).click()
  await expect(page.locator('.trace-focus-note')).toContainText('Review window +12.0–35.0 s')

  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click()
  const download = await downloaded
  const report = JSON.parse(await readFile((await download.path())!, 'utf8'))
  expect(report.insights.history.status).toBe('ready')
  expect(report.insights.history.comparisons.find((item: { channelKey: string }) => item.channelKey.includes('temperature'))).toMatchObject({ current: 75, baseline: 40, historicalLogs: 3, unusual: true })
  expect(report.insights.incidents).toHaveLength(1)
  expect(report.insights.rf.pairs[0].bothLowMs).toBe(3000)

  await page.getByRole('link', { name: 'Units', exact: true }).click()
  await page.getByLabel('Temperature unit').selectOption('°F')
  await page.getByRole('link', { name: 'Library', exact: true }).click()
  await page.getByRole('link', { name: /INSIGHTS.*Open flight library/ }).click()
  await page.locator('.log-main').first().click()
  await expect(page.locator('.history-finding')).toContainText('167.00 °F now · 104.00 °F historical median')
  await expect(page.locator('.trace-focus-note')).toHaveCount(0)
  expect(errors).toEqual([])
  expect(externalRequests).toEqual([])
})
