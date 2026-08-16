# dsh-agy

[![CI](https://github.com/chaos-03x/dsh-agy/actions/workflows/ci.yml/badge.svg)](https://github.com/chaos-03x/dsh-agy/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-agy)](https://www.npmjs.com/package/dsh-agy)

Google Antigravity (agy) access for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
OAuth authentication, a multi-account pool with automatic 429 rotation, device
fingerprinting, and both CLI and web management.

> 中文文档：[docs/README_zh.md](docs/README_zh.md)

## Features

- **OAuth login**: one-click sign-in via browser OAuth callback, with headless
  paste-URL mode and a remote paste-credential blob channel.
- **Two management surfaces**: web and CLI, either one works, core features are
  the same.
- **Multi-account pool**: encrypted account store, usage-aware account
  selection (family-scoped quotas, OMP-aligned ranking), automatic rotation on
  rate limits, per-account cooldown to the real reset time, per-account device
  fingerprints.
- **Quota dashboard**: only active when DSH Web is running; append `/agy` to
  your dsh web address: login, account management, per-model quota bars, model
  testing, credential export/import, fingerprint management.
- **CLI**: `dsh-agy login|status|import|verify|logout` works standalone, with or
  without a harness.

## Screenshots

The `/agy` dashboard inside DSH Web — account cards, per-model quota bars, and
one-shot model tests:

![dsh-agy dashboard](https://raw.githubusercontent.com/chaos-03x/dsh-agy/main/assets/screenshot_en.png)

## Quickstart

### Path A: DSH Web GUI Users (Recommended — 100% Web UI, zero CLI commands)

For users using DeepSeek Harness browser workspace / Web GUI:

```sh
# 1. Install plugin into DSH web profile (via dsh CLI, or pnpx/npx if dsh is not in PATH)
dsh plugin --profile web add dsh-agy
# or: npx @deepseek-ai/dsh plugin --profile web add dsh-agy

# 2. Launch DSH Web
dsh web

# 3. Open dashboard at http://127.0.0.1:3080/agy
# Click "Login with Google", complete OAuth authorization, and start using the agy provider
```

### Path B: Headless / Terminal Only (Standalone CLI)

For Linux VPS, SSH remote servers, or headless CI environments:

```sh
# Run directly without global install (npx / pnpx)
npx dsh-agy login
npx dsh-agy status

# Or install globally
npm install -g dsh-agy
dsh-agy login          # interactive OAuth (browser, --headless paste, or --blob)
dsh-agy status         # list accounts + quota summary
dsh-agy verify         # refresh + health check
dsh-agy import <file>  # import agy auth.json or credential blob (--blob)
dsh-agy logout         # remove account
```

## CLI reference

| Command | Options | Description |
|---|---|---|
| `dsh-agy login` | `--headless` — print the auth URL and wait for a pasted redirect URL<br>`--blob` — print a paste-credential blob instead of storing the account<br>`--port <n>` — loopback callback port (default `51121`)<br>`--project <id>` — bind the login to a specific project<br>`--timeout <ms>` — callback timeout (default `300000`) | Interactive Google OAuth |
| `dsh-agy status` | — | List accounts + per-model quota summary |
| `dsh-agy import <files...>` | `--blob` — the pasted value is a credential blob<br>`--email <email>` — set the account email (skips userinfo verification)<br>`--overwrite` — replace an existing account with the same email | Import agy auth.json files or credential blobs (multiple files / multi-line paste = batch import) |
| `dsh-agy export` | `--index <n>` — export one account by index (default: all)<br>`--out <dir>` — write one `dsh-agy-<index>.blob` per account (default: print to stdout, one blob per line) | Export account credentials as paste blobs |
| `dsh-agy verify` | `--index <n>` — verify one account by index (default: all) | Refresh + health check |
| `dsh-agy logout` | `--index <n>` — account index (default: active)<br>`--email <email>` — account email | Remove an account |

### Path C: Local Development & Link

```sh
git clone https://github.com/chaos-03x/dsh-agy.git
cd dsh-agy && pnpm install && pnpm run build
dsh plugin --profile web link .
```

Requires Node >= 22.

## Uninstall

```sh
# 1. Remove the DSH plugin from a profile
dsh plugin --profile web remove dsh-agy

# 2. Uninstall the CLI
npm uninstall -g dsh-agy

# 3. Optional: delete local account data (accounts + master key + fingerprint override)
dsh-agy logout              # remove accounts first (or skip)
rm -f ~/.dsh/agy-accounts.json
# remove only the AGY_MASTER_KEY line from ~/.dsh/.credentials.yaml — keep other keys!
rm -f ~/.dsh/agy-fingerprint-data.json   # only if you created an override

# 4. Optional: revoke the Google-side authorization
#    Google account security → Third-party access → revoke "Antigravity"
```

Deleting local files does **not** revoke Google-side tokens; the refresh token stays
valid until it expires or you revoke it in your Google account security settings.

## Other things you may care about

### Rotation mechanics

429 (Too Many Requests) responses:

| Category | Behavior |
|---|---|
| `soft_rate_limit` (Retry-After < 3s) | immediate retry on the same account, no cooldown |
| `rate_limited` | cooldown until the server-reported reset time (capped 30min, 5min fallback) + switch to the next account (same account when single) |
| `quota_exhausted` ("quota reached", "individual quota", RESOURCE_EXHAUSTED…) | cooldown until the server-reported reset time (capped 24h) — no further calls to that account until then |
| `unknown` | exponential backoff |

401/403 → account revoked (marked for re-authentication). Success resets the failure
counter.

### About cache hits: why not 99% like DeepSeek V4?

Bottom line: the cache hit strategy is decided by the model provider's cache
mechanics (for us, Antigravity's); agy's mechanics differ from DeepSeek's in
two ways, so its hit rate is naturally a notch below DeepSeek's.

**First, the entry threshold.** DeepSeek's caching is on by default with no
threshold — its very first request already hits a previously cached system
prompt. agy's Gemini-tiered models only start caching once the request prefix
reaches roughly 16k tokens, while DSH's default bare system prompt is only
about 13k — below the line. So every new conversation's first 1-2 requests
are 0%, until the accumulated messages pass 16k.

**Second, how fast the cache updates.** DeepSeek refreshes its cache at the
end of every request — only the newest message misses each round, giving
near-100%. agy's cache updates lag: this round's additions are not hit in
the next round — they enter the cache roughly two rounds later, and requests
for the same content in between all count as misses. Every round wastes
about 1.5-2× its additions; the long-conversation hit rate keeps rising as
the context grows, bounded by the model's context window.

**Practical tips**

- Don't expect 99% from agy: the gap comes from upstream mechanics, with no
  room to optimize.
- If you have a weird number obsession, stuff some custom content into the
  System Prompt (MCP / tool definitions / roleplay ...).

### Storage & secrets

- Accounts: `~/.dsh/agy-accounts.json` — AES-256-GCM encrypted; the master key lives
  in `~/.dsh/.credentials.yaml` (`AGY_MASTER_KEY`, 0600). `$DSH_HOME` relocates both.
- Fingerprint pools (version strings, SDK clients) are user-overridable via
  `~/.dsh/agy-fingerprint-data.json` — no code release needed to keep them current.

## ⚠️ Disclaimer

This plugin authenticates with Google's consumer OAuth client that ships with the
Antigravity desktop product and uses the Antigravity Cloud Code API outside of that
product. This may violate Antigravity's terms of service. **Use at your own risk** —
accounts can be rate-limited, throttled, or banned. Multi-account rotation, device
fingerprinting, and the signature-bypass sentinel are enabled by default and are
designed to work around upstream limits; you are responsible for how you use them and
for any account consequences.

## Credits

This project references logic and data from the following MIT-licensed sources:

| Source | Content |
|---|---|
| [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) (archived) | OAuth flow shape, account-store schema & versioned migration, 429/backoff concepts, fingerprint design |
| [antigravity-claude-proxy PR #170](https://github.com/badrisnarayanan/antigravity-claude-proxy/pull/170) | Device fingerprint generation (via opencode-antigravity-auth) |
| [OmniRoute](https://github.com/diegosouzapw/OmniRoute) | Wire format (envelope, headers, SSE), endpoint order, `agy` token-file parsing, paste-credential blob codec, thoughtSignature replay, 429 category engine |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | Plugin shell, `LlmAdapter` seam, DSH conventions |

## Development

```sh
pnpm install
pnpm test                      # vitest, fixture-driven, no network
pnpm run record:fixtures       # re-record real-API fixtures (needs a real account)
pnpm run e2e                   # real-account end-to-end (needs AGY_REFRESH_TOKEN)
pnpm run debug:request         # endpoint/header bisection probe
pnpm run verify:tools          # live two-turn tool-signature check
npm pack --dry-run             # verify the publishable artifact
```