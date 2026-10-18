import { expect, test } from '@playwright/test'

for (const recording of ['15-00-16', '15-09-08']) {
  test(`maps combined FrSky GPS coordinates (${recording})`, async ({ page }) => {
    await page.goto('/')
    const name = `COMMANDER-2026-10-18-${recording}.csv`
    const directory = process.env.GPS_LOG_DIR
    await page.locator('input[type="file"][accept*="csv"]').setInputFiles(directory ? `${directory}/${name}` : {
      name, mimeType: 'text/csv', buffer: Buffer.from([
        'Date,Time,GPS,GPS alt(m),GPS speed(kt),GPS clock(),Throttle,',
        '2026-10-18,15:00:16.490,43.6739000 -79.8920000,8.10,0.053,2026-10-18 15:00:16,-1024,',
        '2026-10-18,15:00:17.490,43.6749000 -79.8910000,18.10,5.053,2026-10-18 15:00:17,0,',
        '2026-10-18,15:00:18.490,43.6753000 -79.8906000,28.10,8.053,2026-10-18 15:00:18,-1024,'
      ].join('\n'))
    })
    for (let step = 0; step < 3; step += 1) await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Save plane and import' }).click()
    await expect(page.getByText(`Imported ${name}:`)).toBeVisible()
    await page.getByRole('link', { name: /COMMANDER.*Open flight library/ }).click()
    await page.locator('.log-main').click()
    await expect(page.getByRole('heading', { name: 'Flight path' })).toBeVisible()
    await expect(page.getByRole('img', { name: 'GPS flight path colored by altitude' })).toBeVisible()
    await expect(page.locator('.flight-map-stats')).toContainText('100.0%')
  })
}
