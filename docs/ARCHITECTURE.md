# dsh-agy Architecture (ARCHITECTURE)

> Goal: **deep modules** (small interface + large implementation), 4 genuine seams, 2 thin shells.
> This does not mimic the flat-file stack of the opencode plugin (`request.ts` 1881 lines / `request-helpers.ts` 2856 lines of cross-referencing that grew organically under an interception architecture). We inherit its **domain split and schema** but re-organize it into deep modules.

## 1. Module Map and Seams

```
                     ┌─────────────────────────────────────────┐
                     │  index.ts (plugin shell: name/apply ~100 lines) │
                     │  registers adapter + webServer routes + init     │
                     └───────┬──────────────┬──────────────────┘
                             │              │
            ┌────────────────▼───┐   ┌──────▼─────────┐
            │ adapter/           │   │ web/           │
            │ AgyAdapter          │   │ /agy route+HTML  │
            │ (DSH-named seam)    │   │ (thin shell)      │
            └────────┬───────────┘   └──────┬─────────┘
                     │                      │
            ┌────────▼──────────┐   ┌───────▼─────────┐
            │ runtime/          │   │ cli/            │
            │ classify/rotate/  │   │ dsh-agy commands │
            │ fingerprint state │   │ (thin shell)     │
            └────────┬──────────┘   └───────┬─────────┘
                     │                      │
            ┌────────▼──────────┐   ┌───────▼─────────┐
            │ store/accounts    │   │ oauth/          │
            │ interface + JSON  │   │ pure-function   │
            │ impl + test fake  │   │ deep modules    │
            └───────────────────┘   │ authorize/      │
                                    │ exchange/       │
                                    │ refresh/        │
                                    │ bootstrap/blob  │
                                    └─────────────────┘
```

Dependency direction: `oauth/` and `store/` are leaves (no internal deps); `runtime/` depends on both; the three callers `adapter/`, `cli/`, `web/` share the same set of deep modules (**leverage**: one implementation serves three entry points + N tests).

## 2. Deep-Module Inventory (seam = where the interface lives)

| Module | Interface (small) | Implementation (large, hidden) | Test surface |
|---|---|---|---|
| `oauth/authorize` | `authorize(projectId?) -> {url, verifier, state}` | PKCE, state codec, scope set | fixture: URL-arg assertions |
| `oauth/exchange` | `exchange(code, state) -> {tokens, email, projectId}` | multi-endpoint fallback, spoofed UA, userinfo, error-shape parsing | fixture: success/failure payloads |
| `oauth/refresh` | `refresh(auth) -> auth` | refresh, 60s-buffer expiry, invalid_grant revocation, `refresh|projectId` packing | fixture |
| `oauth/bootstrap` | `bootstrap(token) -> {projectId, tier}` | loadCodeAssist / onboardUser, retry, time-box | fixture |
| `oauth/blob` | `encode/decode(blob)` | prefix validation, provider binding anti-replay | pure unit |
| `store/accounts` | `load() / save(acc) / mutate(fn)` | encryption, proper-lockfile, migration chain, dedup, 0600 | **in-memory fake** (second adapter, a legitimate seam) |
| `runtime/classify` | `classify(error) -> Kind` | 429/403/network-error parsing, Retry-After, resetTime | fixture |
| `runtime/rotation` | `onFailure(acc, kind) -> Action` | cooldown to the server-reported reset time (capped 30min/24h), tiered backoff, activeIndex switching, fingerprint-regeneration trigger | state-machine unit tests |
| `runtime/quota` | `rank(accounts, model) -> order` | fetchAvailableModels → per-family quota records (google/anthropic/openai), drained/hot-window guards, required-drain ranking (OMP-aligned) | pure unit |
| `runtime/fingerprint` | `generate() -> Fingerprint` | random platform/arch/SDK pool, history mgmt (<=5), version sync; **data externalized to JSON** | pure unit |
| `adapter/translate` | `toBody(generateOptions) -> RequestBody` | DSH messages/tools -> Gemini contents[], thinking carried verbatim | fixture (recorded requests) |
| `adapter/parse` | `fromSSE(line) -> Chunk[]` | SSE line parsing, candidates[] -> StreamChunk, usage/error events | fixture (recorded responses) |
| `adapter/models` | `listModels() / resolveModel(id)` | fetchAvailableModels fetch + catalog metadata merge + filter + fallback | fixture |

## 3. Thin Shells (deliberately shallow, no abstraction)

- `cli/` subcommands: read store -> call oauth/runtime -> print. No "command framework"; commander drives directly.
- `web/routes.ts`: webServer handler -> calls the same modules. HTML is inline (single-file page, vanilla JS), no front-end framework.
- `adapter/adapter.ts`: the `LlmAdapter` subclass only orchestrates (get token -> refresh -> translate -> stream -> classify error); translation/parsing live in the deep modules.

## 4. Exclusions (why not)

| Reference-project module | Why excluded |
|---|---|
| `recovery.ts` (session recovery) | Interception-architecture artifact: injects synthetic tool_result to patch interrupted tool calls. DSH's adapter is stateless; the loop holds history and manages retries itself |
| `thinking-recovery.ts` + warmup | Root cause was "strip thinking to dodge signature validation"; we carry reasoning blocks verbatim, so this problem doesn't arise |
| `cross-model-integration.ts` | DSH history is provider-neutral blocks; the loop owns cross-model continuity; the source was already deleted in the archived repo |
| gemini-cli header style / dual quota pool | Google no longer supports that client path; a single quota pool simplifies rotation |
| Model-family split `activeIndexByFamily` | One affinity pin + family-scoped quota ranking (`runtime/quota`) covers the need without per-family active indices |
| Plugin Config (schemastery) | No user configuration surface |

## 5. Directory Tree (final shape)

```
dsh-agy/
├── package.json            # name: dsh-agy, type: module, bin: dsh-agy, dsh.bundle patch
├── tsconfig.json / vitest.config.ts
├── LICENSE (MIT)
├── README.md               # English; grey-zone risk disclaimer
├── cordis.patch.yml        # mount entry (activated by `dsh plugin add`)
├── docs/                   # ARCHITECTURE / ARCHITECTURE_zh / ANTIGRAVITY-API / ANTIGRAVITY-API_zh / README_zh
├── scripts/
│   ├── record-fixture.ts   # real-account recording (login/models/stream/refresh)
│   └── e2e.ts              # local e2e (env-injected token, not in CI)
├── src/
│   ├── index.ts            # plugin shell
│   ├── types.ts / invariant.ts
│   ├── oauth/  store/  runtime/  adapter/  cli/  web/
└── tests/
    ├── fixtures/           # recorded payloads (sanitized)
    └── *.test.ts           # Vitest, fixture-driven
```

## 6. Test-Surface Overview (interface as test surface)

- All deep-module tests cross the **same seam** (fixture data -> module interface -> assertions), never testing internals.
- The `store` seam is pinned by the in-memory fake (the second adapter).
- 429/quota paths: covered by fixtures (construct realistic 429 payloads); live verification relies on soft-quota pre-observation + natural rate-limit moments.
- Wrap-up: REAL-composition smoke test — DSH profile mounts the plugin, full `ctx.llm.prepareCall -> stream` path once.
