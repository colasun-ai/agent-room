import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const textFiles = new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n').filter(Boolean).filter((file) => !file.endsWith('package-lock.json')))

function includeGenerated(directory) {
  try {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      if (statSync(path).isDirectory()) includeGenerated(path)
      else textFiles.add(relative(process.cwd(), path))
    }
  } catch { /* build output may not exist yet */ }
}
includeGenerated(join(process.cwd(), 'dist'))
includeGenerated(join(process.cwd(), '.agent-runtime'))

const prefixedSecret = /\b(?:nvapi-[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g
const privateKey = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g
const assignment = /["']?\b(NVIDIA_API_KEY|SESSION_HMAC_SECRET|RISK_HMAC_SECRET|ACCESS_PASSWORD|ACCESS_HMAC_SECRET|TURNSTILE_SECRET_KEY|SMOKE_TEST_SECRET)\b["']?[ \t]*(?:=|:)[ \t]*["']?([^"',;\s}]+)/g
const placeholders = /^(?:replace-with-[a-z0-9-]*|not-a-real-key|session-secret-at-least-long|risk-secret-at-least-long|access-secret-at-least-long|test-access-password|turnstile-secret|test-value|placeholder|example)$/i
const findings = new Set()

function scan(label, content) {
  if (content.includes('\0')) return
  prefixedSecret.lastIndex = 0
  privateKey.lastIndex = 0
  if (prefixedSecret.test(content)) findings.add(`${label}: credential-like token`)
  if (privateKey.test(content)) findings.add(`${label}: private key`)
  assignment.lastIndex = 0
  for (const match of content.matchAll(assignment)) {
    const value = match[2].replace(/["']$/, '')
    if (value.length >= 16 && !placeholders.test(value) && !value.startsWith('${')) findings.add(`${label}: non-placeholder ${match[1]} assignment`)
  }
}

for (const file of textFiles) {
  try { scan(file, readFileSync(file, 'utf8')) } catch { /* unreadable/binary generated file */ }
}

const seenBlobs = new Set()
const indexEntries = execFileSync('git', ['ls-files', '--stage'], { encoding: 'utf8' }).split('\n').filter(Boolean)
for (const entry of indexEntries) {
  const match = entry.match(/^\d+ ([0-9a-f]+) \d\t(.+)$/)
  if (!match || match[2].endsWith('package-lock.json')) continue
  try {
    scan(`INDEX:${match[2]}`, execFileSync('git', ['cat-file', 'blob', match[1]], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }))
    seenBlobs.add(match[1])
  } catch { /* binary or oversized index blob */ }
}
const commits = execFileSync('git', ['rev-list', '--all'], { encoding: 'utf8' }).split('\n').filter(Boolean)
for (const commit of commits) {
  const entries = execFileSync('git', ['ls-tree', '-r', commit], { encoding: 'utf8' }).split('\n').filter(Boolean)
  for (const entry of entries) {
    const match = entry.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/)
    if (!match || seenBlobs.has(match[1]) || match[2].endsWith('package-lock.json')) continue
    seenBlobs.add(match[1])
    try { scan(`${commit.slice(0, 12)}:${match[2]}`, execFileSync('git', ['cat-file', 'blob', match[1]], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })) } catch { /* binary or oversized historical blob */ }
  }
}

if (findings.size) {
  console.error(`Secret scan failed:\n${[...findings].join('\n')}`)
  process.exit(1)
}
console.log(`Secret scan PASS (${textFiles.size} current files, ${seenBlobs.size} historical blobs)`)
