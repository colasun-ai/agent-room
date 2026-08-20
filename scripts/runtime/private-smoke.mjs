import { chromium } from '@playwright/test'

const baseUrl = 'https://agent-room.colasun-ai.workers.dev'
const expectedOrigin = new URL(baseUrl).origin
const password = process.env.AGENTROOM_ACCESS_PASSWORD
if (!password) throw new Error('AGENTROOM_ACCESS_PASSWORD is required')

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  if (new URL(page.url()).origin !== expectedOrigin) throw new Error('Unexpected smoke-test origin')
  const passwordField = page.getByLabel(/Access password/)
  await passwordField.waitFor()
  await passwordField.fill(password)
  await page.getByRole('button', { name: /Enter/ }).click()
  await passwordField.waitFor({ state: 'hidden' })

  const evidence = await page.evaluate(async () => {
    const parseBlocks = (buffer, events) => {
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const raw = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
        if (raw) {
          try { events.push(JSON.parse(raw)) } catch { events.push({ type: 'malformed' }) }
        }
        boundary = buffer.indexOf('\n\n')
      }
      return buffer
    }
    const roomId = `browser-${crypto.randomUUID()}`
    const configResponse = await fetch('/api/config', { credentials: 'same-origin' })
    const publicConfig = configResponse.ok ? await configResponse.json() : {}
    const runId = crypto.randomUUID()
    const roster = [
      { agentId: 'agent-alpha', nameKey: 'alpha', enabled: true },
      { agentId: 'agent-beta', nameKey: 'beta', enabled: true },
    ]
    const agents = [
      { id: 'agent-alpha', name: 'Alpha', role: 'Reviewer', avatar: 'A', personality: 'thorough', goal: 'Verify cancellation', enabled: true, temperature: 0 },
      { id: 'agent-beta', name: 'Beta', role: 'Engineer', avatar: 'B', personality: 'precise', goal: 'Verify recovery', enabled: true, temperature: 0 },
    ]
    const post = (path, body, signal) => fetch(path, { method: 'POST', credentials: 'same-origin', signal, headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body) })
    const session = await post('/api/session', {})
    const registered = await post('/api/rooms/register', { roomId, runId, turnLimit: 6, runTurnsCompleted: 0, totalTurnsCompleted: 0, status: 'running', protocolTag: 'agentroom.v1', roster })
    if (!session.ok || !registered.ok) {
      let sessionError, registerError
      try { sessionError = (await session.json()).error?.code } catch { /* non-JSON response */ }
      try { registerError = (await registered.json()).error?.code } catch { /* non-JSON response */ }
      return { origin: globalThis.location.origin, configStatus: configResponse.status, releaseClass: publicConfig.releaseClass, aiEnabled: publicConfig.aiEnabled, sessionStatus: session.status, sessionError, registerStatus: registered.status, registerError, error: 'setup-failed' }
    }

    const abortController = new AbortController()
    const first = await post(`/api/rooms/${roomId}/turn`, {
      requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), roomId, runId, protocolTag: 'agentroom.v1', appBuildId: 'browser-abort-smoke',
      topic: 'Write a detailed 600-word verification report.', agents, messages: [],
    }, abortController.signal)
    const firstEvents = [], firstReader = first.body?.getReader(), decoder = new TextDecoder()
    let firstBuffer = ''
    if (firstReader) {
      while (true) {
        const { done, value } = await firstReader.read()
        firstBuffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n')
        firstBuffer = parseBlocks(firstBuffer, firstEvents)
        if (firstEvents.some((event) => event.type === 'start')) {
          abortController.abort()
          await firstReader.cancel().catch(() => undefined)
          break
        }
        if (done) break
      }
    }
    const firstTypes = firstEvents.map((event) => event.type)
    const serverTurnId = firstEvents.find((event) => event.type === 'start')?.serverTurnId
    const cancelled = serverTurnId ? await post(`/api/rooms/${roomId}/cancel`, { serverTurnId }) : undefined
    let cancelError
    try { cancelError = (await cancelled?.clone().json())?.error?.code } catch { /* non-JSON response */ }
    await new Promise((resolve) => setTimeout(resolve, 250))

    const second = await post(`/api/rooms/${roomId}/turn`, {
      requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), roomId, runId, protocolTag: 'agentroom.v1', appBuildId: 'browser-recovery-smoke',
      topic: 'Reply with one short sentence confirming recovery after cancellation.', agents, messages: [],
    })
    if (!second.ok) {
      let code
      try { code = (await second.json()).error?.code } catch { /* non-JSON response */ }
      return { configStatus: configResponse.status, releaseClass: publicConfig.releaseClass, aiEnabled: publicConfig.aiEnabled, sessionStatus: session.status, registerStatus: registered.status, firstStatus: first.status, firstTypes, cancelStatus: cancelled?.status, cancelError, secondStatus: second.status, secondError: code }
    }
    const secondEvents = [], secondReader = second.body?.getReader()
    let secondBuffer = ''
    if (secondReader) {
      while (true) {
        const { done, value } = await secondReader.read()
        secondBuffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n')
        secondBuffer = parseBlocks(secondBuffer, secondEvents)
        if (done) break
      }
    }
    return { configStatus: configResponse.status, releaseClass: publicConfig.releaseClass, aiEnabled: publicConfig.aiEnabled, sessionStatus: session.status, registerStatus: registered.status, firstStatus: first.status, firstTypes, aborted: abortController.signal.aborted, cancelStatus: cancelled?.status, cancelError, secondStatus: second.status, actualModel: secondEvents.find((event) => event.type === 'start')?.actualModel, secondTypes: secondEvents.map((event) => event.type) }
  })
  console.log(JSON.stringify(evidence))
  if (evidence.configStatus !== 200 || evidence.releaseClass !== 'PRIVATE_BETA' || evidence.aiEnabled !== true || !evidence.aborted || !evidence.firstTypes?.includes('start') || evidence.cancelStatus !== 200 || evidence.secondStatus !== 200 || !evidence.secondTypes?.includes('done')) process.exitCode = 1
} finally {
  await browser.close()
}
