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

test('creates a room, trusts streamed speaker, pauses, edits, and restores IndexedDB history', async ({ page }) => {
  let revision = 1
  let registerBody: Record<string, unknown> | undefined
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/session') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ expiresAt: Date.now() + 86_400_000 }) })
    if (path === '/api/rooms/register') {
      registerBody = request.postDataJSON() as Record<string, unknown>
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ roomId: registerBody.roomId, runId: registerBody.runId, controlRevision: revision, expiresAt: Date.now() + 43_200_000 }) })
    }
    if (path.endsWith('/control')) {
      revision += 1
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ controlRevision: revision }) })
    }
    if (path.endsWith('/turn')) {
      const body = request.postDataJSON() as { requestId: string; agents: Array<{ id: string }> }
      revision += 1
      const serverTurnId = crypto.randomUUID()
      const events = [
        { type: 'queued', requestId: body.requestId, serverTurnId, queueState: 'short' },
        { type: 'start', requestId: body.requestId, serverTurnId, serverChosenAgentId: body.agents[0].id, actualModel: 'test-model', protocolTag: 'agentroom.v1' },
        { type: 'content', requestId: body.requestId, serverTurnId, delta: 'A verified streamed reply.' },
        { type: 'done', requestId: body.requestId, serverTurnId, actualModel: 'test-model', durationMs: 10, controlRevision: revision, runTurnsCompleted: 1, totalTurnsCompleted: 1 },
      ]
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') })
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
  })

  await page.goto('/new?template=startup')
  await page.getByText('Create & start', { exact: false }).click()
  await expect(page).toHaveURL(/\/room\//)
  await expect(page.getByText('A verified streamed reply.')).toBeVisible()
  await page.getByRole('button', { name: /Pause/ }).click()
  await expect(page.getByText('PAUSED')).toBeVisible()
  expect(registerBody).not.toHaveProperty('topic')
  expect(registerBody).not.toHaveProperty('messages')

  await page.reload()
  await expect(page.getByText('A verified streamed reply.')).toBeVisible()
  await page.getByRole('button', { name: /Edit agents/ }).click()
  await page.getByLabel('Name').first().fill('Atlas')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Atlas', { exact: true }).first()).toBeVisible()
})
