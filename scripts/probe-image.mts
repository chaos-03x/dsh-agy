// Image-input probe: verifies that the v1internal endpoint accepts Gemini
// `inlineData` parts (the wire shape translate.ts now emits for image blocks).
// Sends ONE tiny 1x1 PNG against a configured account and reports the status
// plus the first response bytes — a 400 here means the inlineData contract
// needs to be reworked before enabling image annotation.
//
// Usage: pnpm exec tsx scripts/probe-image.mts [modelId]
// Requires a configured account (~/.dsh/agy-accounts.json + master key).
// Runs through the env-configured proxy (HTTP_PROXY/HTTPS_PROXY) like all
// other scripts.
import { refreshAccessToken } from '../src/oauth/refresh.ts'
import { loadMasterKey, resolveDshHome, deriveKey, createAesGcmCodec } from '../src/store/keyring.ts'
import { JsonAccountStore, decryptStorage } from '../src/store/accounts.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fetchAgyFirstOk } from '../src/oauth/constants.ts'

const modelId = process.argv[2] ?? 'gemini-3.6-flash-high'

const dshHome = resolveDshHome()
const masterKey = loadMasterKey(dshHome)
const codec = createAesGcmCodec(deriveKey(masterKey))
const storage = decryptStorage(JSON.parse(readFileSync(join(dshHome, 'agy-accounts.json'), 'utf8')), codec)
const account = storage.accounts[0]
if (!account) {
  console.error('no configured agy account — run `dsh-agy login` first')
  process.exit(2)
}
const refreshed = await refreshAccessToken({ access: '', expires: 0, refresh: account.refresh })
const access = refreshed.type === 'success' ? refreshed.auth.access : ''
if (!access) {
  console.error('token refresh failed:', refreshed.type === 'failure' ? refreshed.message : refreshed.type)
  process.exit(2)
}

// 1x1 transparent PNG (67 bytes) — the smallest valid raster for a wire probe.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const body = {
  project: account.projectId || undefined,
  requestId: `probe/${Date.now()}/image`,
  model: modelId,
  userAgent: 'antigravity',
  requestType: 'agent',
  request: {
    contents: [{
      role: 'user',
      parts: [
        { text: 'Describe the image in one sentence.' },
        { inlineData: { mimeType: 'image/png', data: PNG_BASE64 } },
      ],
    }],
  },
}

const response = await fetchAgyFirstOk('/v1internal:streamGenerateContent?alt=sse', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${access}`,
    Accept: 'text/event-stream',
    'User-Agent': 'antigravity/cli/1.19.0 (aidev_client; os_type=linux; arch=x86_64; auth_method=consumer)',
  },
  body: JSON.stringify(body),
})

const text = await response.text()
console.log(`model=${modelId} status=${response.status}`)
if (!response.ok) {
  console.error(`UPSTREAM REJECTS inlineData (${response.status}): ${text.slice(0, 400)}`)
  process.exit(1)
}
const firstText = text.split('\n').find((line) => line.startsWith('data:') && line.includes('"text"'))
console.log('OK — inlineData accepted')
console.log(`first text delta: ${firstText?.slice(0, 300) ?? '(none)'}`)
