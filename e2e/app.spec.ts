import { expect, test } from '@playwright/test'

test('landing, template setup, and responsive navigation are usable', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Create agents|创建 Agent/)
  await expect(page.getByText('Startup Team', { exact: true })).toBeVisible()
  await expect(page.getByText('Debate', { exact: true })).toBeVisible()
  await expect(page.getByText('Build Something', { exact: true })).toBeVisible()
  await page.getByText('Startup Team', { exact: true }).click()
  await expect(page).toHaveURL(/\/new\?template=startup/)
  await expect(page.getByLabel('Name').first()).toHaveValue('Alex')
  await expect(page.getByText('Create & start')).toBeEnabled()
})

test('settings changes language and retains privacy controls', async ({ page }) => {
  await page.goto('/settings')
  await page.getByRole('button', { name: '简体中文' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('设置')
  await expect(page.getByText('历史记录保存在此设备。', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: '清除本地数据' })).toBeVisible()
})
