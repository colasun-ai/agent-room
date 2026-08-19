import { expect, test, type Page } from '@playwright/test'

type TurnScript = {
  kind: 'success' | 'error' | 'hang'
  speakerIndex?: number
  delta?: string
  code?: string
  runTurnsCompleted?: number
  totalTurnsCompleted?: number
  stepMs?: number
}

async function installTurnScripts(page: Page, scripts: TurnScript[]) {
  await page.addInitScript((turnScripts) => {
    const originalFetch = window.fetch.bind(window)
    const bodies: unknown[] = []
    Object.assign(window, { __agentRoomTurnBodies: bodies })
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.includes('/api/rooms/') || !url.endsWith('/turn')) return originalFetch(input, init)
      const body = JSON.parse(String(init?.body ?? '{}')) as { requestId: string; agents: Array<{ id: string }> }
      bodies.push(body)
      const script = turnScripts[Math.min(bodies.length - 1, turnScripts.length - 1)]
      const serverTurnId = `server-turn-${bodies.length}`
      const encoder = new TextEncoder()
      const events: Array<Record<string, unknown>> = [
        { type: 'queued', requestId: body.requestId, serverTurnId, queueState: 'short' },
      ]
      if (script.kind !== 'hang') {
        events.push({ type: 'start', requestId: body.requestId, serverTurnId, serverChosenAgentId: body.agents[script.speakerIndex ?? 0].id, actualModel: 'test-model', protocolTag: 'agentroom.v1' })
        if (script.delta) events.push({ type: 'content', requestId: body.requestId, serverTurnId, delta: script.delta })
        if (script.kind === 'error') events.push({ type: 'error', requestId: body.requestId, serverTurnId, code: script.code ?? 'MODEL_UNAVAILABLE', retryable: true })
        else events.push({ type: 'done', requestId: body.requestId, serverTurnId, actualModel: 'test-model', durationMs: 10, controlRevision: bodies.length + 1, runTurnsCompleted: script.runTurnsCompleted ?? bodies.length, totalTurnsCompleted: script.totalTurnsCompleted ?? bodies.length })
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false
          const closeOnAbort = () => { if (!closed) { closed = true; controller.error(new DOMException('Aborted', 'AbortError')) } }
          init?.signal?.addEventListener('abort', closeOnAbort, { once: true })
          events.forEach((event, index) => window.setTimeout(() => {
            if (closed) return
            controller.enqueue(encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`))
            if (index === events.length - 1 && script.kind !== 'hang') { closed = true; controller.close() }
          }, (script.stepMs ?? 120) * (index + 1)))
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    }
  }, scripts)
}

async function installControlApi(page: Page, options: { turnstile?: boolean } = {}) {
  const state = { revision: 1, registers: 0, controls: [] as Array<Record<string, unknown>>, skips: 0, sessions: [] as Array<Record<string, unknown>>, challengeAction: undefined as string | undefined }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/config') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ releaseClass: 'PUBLIC_BETA', protocolTag: 'agentroom.v1', controlSchemaRevision: 1, aiEnabled: true, capacityState: 'available', limits: { agentsMin: 2, agentsMax: 6, turnLimits: [6, 12, 20] }, ...(options.turnstile ? { turnstileSiteKey: 'test-site-key' } : {}) }) })
    if (path === '/api/session') {
      state.sessions.push((request.postDataJSON() ?? {}) as Record<string, unknown>)
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ expiresAt: Date.now() + 86_400_000 }) })
    }
    if (path === '/api/rooms/register') {
      state.registers += 1
      const body = request.postDataJSON() as Record<string, unknown>
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ roomId: body.roomId, runId: body.runId, controlRevision: state.revision, expiresAt: Date.now() + 43_200_000 }) })
    }
    if (path.endsWith('/control')) {
      const body = request.postDataJSON() as Record<string, unknown>
      if (state.challengeAction === body.action) { state.challengeAction = undefined; return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'CHALLENGE_REQUIRED', message: 'CHALLENGE_REQUIRED', retryable: false } }) }) }
      state.controls.push(body); state.revision += 1
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ controlRevision: state.revision }) })
    }
    if (path.endsWith('/skip')) {
      if (state.challengeAction === 'skip') { state.challengeAction = undefined; return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'CHALLENGE_REQUIRED', message: 'CHALLENGE_REQUIRED', retryable: false } }) }) }
      state.skips += 1; state.revision += 1
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ controlRevision: state.revision, runTurnsCompleted: 1, totalTurnsCompleted: 1 }) })
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
  })
  return state
}

async function installTurnstileWidget(page: Page) {
  await page.addInitScript(() => {
    Object.assign(window, { turnstile: {
      render(container: HTMLElement, options: { callback: (token: string) => void }) { const button = document.createElement('button'); button.textContent = 'Verify'; button.onclick = () => options.callback('verified-token'); container.append(button); return 'widget-1' },
      remove() { document.querySelectorAll('.turnstile-challenge').forEach((element) => element.replaceChildren()) },
    } })
  })
}

async function clickRoomControl(page: Page, name: string | RegExp) {
  const menu = page.getByRole('button', { name: 'Room menu' })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('button', { name }).click()
}

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

test('keeps keyboard focus inside dialogs and returns focus after Escape', async ({ page }) => {
  await installTurnScripts(page, [{ kind: 'success', delta: 'Ready for editing.', runTurnsCompleted: 12, totalTurnsCompleted: 12, stepMs: 40 }])
  await installControlApi(page)
  await page.goto('/new?template=startup')
  await page.getByText('Create & start', { exact: false }).click()
  await expect(page.getByText('Ready for editing.', { exact: true })).toBeVisible()
  const menu = page.getByRole('button', { name: 'Room menu' })
  if (await menu.isVisible()) {
    await menu.click(); await page.keyboard.press('Escape'); await expect(menu).toBeFocused()
  }
  await clickRoomControl(page, /Edit agents/)
  const dialog = page.getByRole('dialog', { name: 'Edit agents' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator(':focus')).toHaveCount(1)
  await page.keyboard.press('Shift+Tab')
  await expect(dialog.locator(':focus')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('button', { name: /Edit agents/ })).toBeFocused()
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
  await clickRoomControl(page, /Pause/)
  await expect(page.getByText('PAUSED')).toBeVisible()
  expect(registerBody).not.toHaveProperty('topic')
  expect(registerBody).not.toHaveProperty('messages')

  await page.reload()
  await expect(page.getByText('A verified streamed reply.')).toBeVisible()
  await clickRoomControl(page, /Edit agents/)
  await page.getByLabel('Name').first().fill('Atlas')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Atlas', { exact: true }).first()).toBeVisible()
})

test('shows the real lifecycle, accepts an interruption, and honors direct address after resume', async ({ page }) => {
  await installTurnScripts(page, [
    { kind: 'success', speakerIndex: 0, delta: 'First streamed answer.', runTurnsCompleted: 1, totalTurnsCompleted: 1, stepMs: 700 },
    { kind: 'success', speakerIndex: 1, delta: 'Maya follows up.', runTurnsCompleted: 2, totalTurnsCompleted: 2, stepMs: 180 },
  ])
  const apiState = await installControlApi(page)
  await page.goto('/new?template=startup')
  await page.getByText('Create & start', { exact: false }).click()
  await expect(page.locator('.message[data-status="waiting"]')).toBeVisible()
  await expect(page.locator('.message[data-status="thinking"]')).toBeVisible()
  await expect(page.locator('.message[data-status="streaming"]')).toContainText('First streamed answer.')
  const composer = page.getByLabel('Message the room — try @Name…')
  await composer.fill('@Maya please challenge that point')
  await composer.press('Enter')
  await expect(page.getByText('@Maya please challenge that point', { exact: true })).toBeVisible()
  await expect(page.locator('.message[data-status="completed"]').filter({ hasText: 'First streamed answer.' })).toBeVisible()
  await clickRoomControl(page, /Pause/)
  await expect(page.getByText('PAUSED')).toBeVisible()
  await clickRoomControl(page, /Resume/)
  await expect(page.locator('.message[data-status="completed"]').filter({ hasText: 'Maya follows up.' })).toBeVisible()
  const bodies = await page.evaluate(() => (window as unknown as { __agentRoomTurnBodies: Array<{ latestUserDirectAddress?: string; agents: Array<{ id: string; normalizedName: string }>; messages: Array<{ content: string }> }> }).__agentRoomTurnBodies)
  expect(bodies[1].latestUserDirectAddress).toBe(bodies[1].agents.find((agent) => agent.normalizedName === 'maya')?.id)
  expect(bodies[1].messages.some((message) => message.content.startsWith('@Maya'))).toBe(true)
  expect(apiState.controls.map((item) => item.action)).toEqual(expect.arrayContaining(['pause', 'resume']))
})

test('retries the same failed server turn without concatenating a partial response', async ({ page }) => {
  await installTurnstileWidget(page)
  await installTurnScripts(page, [
    { kind: 'error', delta: 'A partial draft.', code: 'MODEL_UNAVAILABLE', stepMs: 90 },
    { kind: 'success', delta: 'A clean retry.', runTurnsCompleted: 6, totalTurnsCompleted: 6, stepMs: 90 },
  ])
  const apiState = await installControlApi(page, { turnstile: true })
  await page.goto('/new?template=startup')
  await page.getByText('Create & start', { exact: false }).click()
  await expect(page.locator('.message[data-status="interrupted"]')).toContainText('A partial draft.')
  apiState.challengeAction = 'resume'
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByRole('button', { name: 'Verify' })).toBeVisible()
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.locator('.message[data-status="completed"]').filter({ hasText: 'A clean retry.' })).toBeVisible()
  const bodies = await page.evaluate(() => (window as unknown as { __agentRoomTurnBodies: Array<{ retryOfServerTurnId?: string; messages: Array<{ content: string }> }> }).__agentRoomTurnBodies)
  expect(bodies[1].retryOfServerTurnId).toBe('server-turn-1')
  expect(bodies[1].messages.some((message) => message.content === 'A partial draft.')).toBe(false)
  await expect(page.locator('.message[data-status="completed"]').filter({ hasText: 'A clean retry.' })).not.toContainText('A partial draft.')
})

test('keeps a partial only after explicit confirmation', async ({ page }) => {
  await installTurnScripts(page, [
    { kind: 'error', delta: 'Useful fragment.', code: 'MODEL_UNAVAILABLE', stepMs: 70 },
    { kind: 'success', delta: 'After the skipped slot.', runTurnsCompleted: 6, totalTurnsCompleted: 6, stepMs: 70 },
  ])
  const apiState = await installControlApi(page)
  await page.goto('/new?template=startup')
  await page.getByText('Create & start', { exact: false }).click()
  await expect(page.locator('.message[data-status="interrupted"]')).toContainText('Useful fragment.')
  await page.getByRole('button', { name: 'Keep partial' }).click()
  await expect(page.locator('.message[data-status="retainedPartial"]')).toContainText('Useful fragment.')
  await clickRoomControl(page, /Resume/)
  await expect(page.locator('.message[data-status="completed"]').filter({ hasText: 'After the skipped slot.' })).toBeVisible()
  expect(apiState.skips).toBe(0)
  const bodies = await page.evaluate(() => (window as unknown as { __agentRoomTurnBodies: Array<{ messages: Array<{ content: string; status: string }> }> }).__agentRoomTurnBodies)
  expect(bodies[1].messages).toEqual(expect.arrayContaining([expect.objectContaining({ content: 'Useful fragment.', status: 'retainedPartial' })]))
})

test('skips a pre-token failure without making an upstream request for the skipped slot', async ({ page }) => {
  await installTurnScripts(page, [
    { kind: 'error', code: 'MODEL_UNAVAILABLE', stepMs: 60 },
    { kind: 'success', delta: 'New run reply.', runTurnsCompleted: 12, totalTurnsCompleted: 13, stepMs: 60 },
  ])
  const apiState = await installControlApi(page)
  await page.goto('/new?template=startup')
  await page.getByText('Create & start', { exact: false }).click()
  await expect(page.locator('.message[data-status="error"]')).toBeVisible()
  await page.getByRole('button', { name: 'Skip' }).click()
  expect(apiState.skips).toBe(1)
  await expect(page.locator('.message[data-status="completed"]').filter({ hasText: 'New run reply.' })).toBeVisible()
  await expect(page.getByText('Continue', { exact: true })).toBeVisible()
  const bodiesBeforeContinue = await page.evaluate(() => (window as unknown as { __agentRoomTurnBodies: unknown[] }).__agentRoomTurnBodies)
  expect(bodiesBeforeContinue).toHaveLength(2)
})

test('continues from a completed 12-turn run into a distinct 6-turn run with room total 18', async ({ page }) => {
  await installTurnScripts(page, [
    { kind: 'success', delta: 'Run twelve complete.', runTurnsCompleted: 12, totalTurnsCompleted: 12, stepMs: 60 },
    { kind: 'success', delta: 'Run six complete.', runTurnsCompleted: 6, totalTurnsCompleted: 18, stepMs: 60 },
  ])
  const apiState = await installControlApi(page)
  await page.goto('/new?template=startup')
  await page.getByText('Create & start', { exact: false }).click()
  await expect(page.getByText('Continue', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '6 turns' }).click()
  await expect.poll(() => apiState.controls.some((item) => item.action === 'continue')).toBe(true)
  await expect(page.locator('.message[data-status="completed"]').filter({ hasText: 'Run six complete.' })).toBeVisible()
  const persisted = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('agent-room'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const readAll = <T,>(store: string) => new Promise<T[]>((resolve, reject) => { const request = database.transaction(store).objectStore(store).getAll(); request.onsuccess = () => resolve(request.result as T[]); request.onerror = () => reject(request.error) })
    const [runs, rooms] = await Promise.all([readAll<{ id: string; turnsCompleted: number; turnLimit: number }>('runs'), readAll<{ activeRunId: string; totalTurnsCompleted: number }>('rooms')])
    database.close()
    return { runs, activeRunId: rooms[0].activeRunId, totalTurnsCompleted: rooms[0].totalTurnsCompleted }
  })
  expect(persisted.runs).toHaveLength(2)
  expect(persisted.runs.find((run) => run.id !== persisted.activeRunId)).toMatchObject({ turnLimit: 12, turnsCompleted: 12 })
  expect(persisted.runs.find((run) => run.id === persisted.activeRunId)).toMatchObject({ turnLimit: 6, turnsCompleted: 6 })
  expect(persisted.totalTurnsCompleted).toBe(18)
})

test('freezes Pause locally and replays Pause, Skip, and Continue after room challenges', async ({ page }) => {
  await installTurnstileWidget(page)
  await installTurnScripts(page, [
    { kind: 'success', delta: 'First turn.', runTurnsCompleted: 1, totalTurnsCompleted: 1, stepMs: 60 },
    { kind: 'error', code: 'MODEL_UNAVAILABLE', stepMs: 60 },
    { kind: 'success', delta: 'Finished after skip.', runTurnsCompleted: 12, totalTurnsCompleted: 13, stepMs: 60 },
    { kind: 'success', delta: 'Continued after verification.', runTurnsCompleted: 6, totalTurnsCompleted: 19, stepMs: 60 },
  ])
  const apiState = await installControlApi(page, { turnstile: true })
  await page.goto('/new?template=startup')
  await page.getByText('Create & start', { exact: false }).click()
  await expect(page.getByText('First turn.', { exact: true })).toBeVisible()
  apiState.challengeAction = 'pause'
  await clickRoomControl(page, /Pause/)
  await expect(page.getByText('PAUSED')).toBeVisible()
  await page.waitForTimeout(800)
  expect(await page.evaluate(() => (window as unknown as { __agentRoomTurnBodies: unknown[] }).__agentRoomTurnBodies.length)).toBe(1)
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect.poll(() => apiState.controls.filter((item) => item.action === 'pause').length).toBe(1)
  await clickRoomControl(page, /Resume/)
  await expect(page.locator('.message[data-status="error"]')).toBeVisible()
  apiState.challengeAction = 'skip'
  await page.getByRole('button', { name: 'Skip' }).click()
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect.poll(() => apiState.skips).toBe(1)
  await expect(page.getByText('Continue', { exact: true })).toBeVisible()
  apiState.challengeAction = 'continue'
  await page.getByRole('button', { name: '6 turns' }).click()
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect.poll(() => apiState.controls.filter((item) => item.action === 'continue').length).toBe(1)
  await expect(page.getByText('Continued after verification.', { exact: true })).toBeVisible()
})

test('stops a queued request and synchronizes the paused room', async ({ page }) => {
  await installTurnScripts(page, [{ kind: 'hang', stepMs: 70 }])
  const apiState = await installControlApi(page)
  await page.goto('/new?template=startup')
  await page.getByText('Create & start', { exact: false }).click()
  await expect(page.locator('.message[data-status="waiting"]')).toBeVisible()
  await clickRoomControl(page, 'Stop current turn')
  await expect(page.locator('.message[data-status="stopped"]')).toBeVisible()
  await expect(page.getByText('PAUSED')).toBeVisible()
  expect(apiState.controls.some((item) => item.action === 'pause')).toBe(true)
})

test('blocks double-submit and presents a stable 429 capacity message', async ({ page }) => {
  await installTurnScripts(page, [{ kind: 'error', code: 'UPSTREAM_RATE_LIMITED', stepMs: 60 }])
  const apiState = await installControlApi(page)
  await page.goto('/new?template=startup')
  await page.getByText('Create & start', { exact: false }).evaluate((button: HTMLElement) => { button.click(); button.click() })
  await expect(page).toHaveURL(/\/room\//)
  await expect(page.getByText('Shared public AI capacity is temporarily limited.', { exact: false })).toBeVisible()
  expect(apiState.registers).toBe(1)
})

test('recovers an existing room through Turnstile and explains daily exhaustion', async ({ page }) => {
  await installTurnstileWidget(page)
  await installTurnScripts(page, [
    { kind: 'error', code: 'CHALLENGE_REQUIRED', stepMs: 60 },
    { kind: 'error', code: 'DAILY_CAPACITY_EXHAUSTED', stepMs: 60 },
  ])
  const apiState = await installControlApi(page, { turnstile: true })
  await page.goto('/new?template=startup')
  await page.getByText('Create & start', { exact: false }).click()
  await expect(page.getByText('A quick verification is required', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect.poll(() => apiState.sessions.some((body) => body.challengeToken === 'verified-token')).toBe(true)
  await expect(page.getByText('Today’s shared public AI allowance has been used.', { exact: false })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Source code' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Deploy your own' })).toBeVisible()
})
