import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((file) => !file.endsWith('package-lock.json'))

const patterns = [
  /nvapi-[A-Za-z0-9_-]{12,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:NVIDIA_API_KEY|SESSION_HMAC_SECRET|TURNSTILE_SECRET_KEY|SMOKE_TEST_SECRET)\s*=\s*(?!replace-|$)[^\s]+/,
]

const findings = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const pattern of patterns) {
    if (pattern.test(text)) findings.push(`${file}: ${pattern}`)
  }
}

if (findings.length) {
  console.error(`Secret scan failed:\n${findings.join('\n')}`)
  process.exit(1)
}
console.log(`Secret scan PASS (${files.length} tracked files)`)

