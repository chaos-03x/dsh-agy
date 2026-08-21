# Antigravity upstream wire facts (ANTIGRAVITY-API)

> Fact list cross-checked against two reference projects (not speculation). Wire format is authoritative against what this project's `scripts/record-fixture.ts` records (may drift as Google iterates).

## 1. Endpoints & Environments

| Environment | Base URL | Status |
|---|---|---|
| Production | `https://cloudcode-pa.googleapis.com` | Returns 429 for consumer OAuth accounts (enterprise/license use) — verified |
| Daily | `https://daily-cloudcode-pa.googleapis.com` | **Main endpoint for consumer accounts (200, verified)**; source: head of OmniRoute runtime chain |
| Daily (Sandbox) | `https://daily-cloudcode-pa.sandbox.googleapis.com` | Verified usable (fallback); source: CLIProxy/Vibeproxy practice (opencode constant comments), OmniRoute only in discovery chain |
| Autopush (Sandbox) | `https://autopush-cloudcode-pa.sandbox.googleapis.com` | Returns 403 (consumer has no license), tail fallback; source: CLIProxy practice, not in OmniRoute |

Known environment constraint: upstream may return `FAILED_PRECONDITION: User location is not supported for the API use` (egress location unsupported) — unrelated to code.

OAuth endpoints (fixed): authorize `https://accounts.google.com/o/oauth2/v2/auth`; token `https://oauth2.googleapis.com/token`; userinfo `https://www.googleapis.com/oauth2/v1/userinfo?alt=json`.

## 2. Actions

| Action | Path | Purpose |
|---|---|---|
| Streaming generation | `POST /v1internal:streamGenerateContent?alt=sse` | primary channel |
| Non-streaming generation | `POST /v1internal:generateContent` | fallback |
| Project discovery | `POST /v1internal:loadCodeAssist` | get projectId / tier after login |
| New-account onboarding | `POST /v1internal:onboardUser` | onboarding for accounts with no project (with `tier_id` + metadata `{ideType:"ANTIGRAVITY"}` only; retry 3x + 3-7s jitter, ban-safety — a fixed fast loop looks like script automation) |
| Model discovery | `POST /v1internal:fetchAvailableModels` | per-model `quotaInfo` (remainingFraction/resetTime) |
| Model list (alternate) | `/v1internal:models` | second path |

## 3. Auth & Headers

- `Authorization: Bearer {access_token}`; `Content-Type: application/json`; streaming also sends `Accept: text/event-stream`.
- `User-Agent: antigravity/{version} {platform}/{arch}` (platform ∈ {windows, darwin}, arch ∈ {amd64, arm64}; version must stay fresh — externalized to JSON).
- `X-Goog-Api-Client`: pool `google-cloud-sdk vscode_cloudshelleditor/0.1`, `vscode/1.86.0`, `vscode/1.87.0`, `vscode/1.96.0`.
- `Client-Metadata` actually only sends `{ideType:"ANTIGRAVITY"}` in code (freely-added `platform`/`pluginType` get rejected by backend enum validation).
- Dual style (antigravity vs gemini-cli) **not done**.
- **Request envelope (OmniRoute active format)**: top level `{project, requestId, model, userAgent:"antigravity", requestType:"agent", request:{contents, tools?, toolConfig:{functionCallingConfig:{mode:"VALIDATED"}}, generationConfig?, sessionId}}`. Claude models strip the trailing model turn; tool schemas are reduced to an upstream allowlist with normalized keyword values (backend rejects ANY unknown keyword AND any non-protobuf value shape; see §3.1).

### 3.1 Tool Schema Contract (verified; whack-a-mole defense)

The backend parses tool `parameters` as a strict protobuf `Schema`: unknown keys (`$schema`, `propertyNames`, `pattern`, `minLength`, ...) and invalid value shapes (`enum: [true]` → TYPE_STRING 400; `type: ["string","number"]` → Unknown name "type" 400) each fail the whole request. The sanitizer (`src/adapter/translate.ts` `sanitizeToolSchema`) enforces the full contract, not per-keyword patches:

- **Keys** — only `type, format, title, description, nullable, items, enum, default, properties, required, additionalProperties` survive.
- **Values** — `type` must be a single enum string (union arrays normalize to the first non-`null` type, `"null"` maps to `nullable`); `enum` items must be strings (non-strings filtered, empty enum omitted entirely); `properties` is a name→schema map; `items` is a nested schema; `additionalProperties` accepts a nested schema or a boolean (`false` = no extra keys; live-verified accepted by the Antigravity upstream — OmniRoute strips it only because the public Gemini API rejects it); `required` is a string array.
- **Tool names** — `functionDeclarations[].name` accepts only `[a-zA-Z0-9_]` and ≤64 chars (MCP tool names are arbitrary; sanitized, overlong/duplicate names get a sha256 tail). Builtin Gemini tool names (`google_search`, `web_search`, `search_web`, `googleSearch`) are excluded entirely (upstream treats them as native tools).
- **Tests** — `tests/adapter.test.ts` `assertUpstreamContract` recursively asserts every keyword and value shape of the sanitized output, so any future unknown key or invalid value shape fails CI before a user hits upstream; each known rejection shape is pinned as a fixture. Real-world MCP schemas (GitHub MCP `issue_write` was the trigger: boolean enum + union type) belong in the corpus to surface shapes hand-written tests miss.

## 4. OAuth Details

- client_id `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com` (Antigravity desktop client, public credential; secret handled via OmniRoute `resolvePublicCred` mode).
- scopes: `cloud-platform` + `userinfo.email` + `userinfo.profile` + `cclog` + `experimentsandconfigs`; **no openid**.
- `access_type=offline`, `prompt=consent`, optional PKCE S256, `state` encodes `{verifier, projectId}`.
- **Google `firstparty/nativeapp` consent: only releases the code when a loopback redirect is reachable** -> remote hosts must use paste blob (`omniroute-cred-v1.` + base64url).
- Token-exchange failure error shapes vary: `error` string / object (`code|status|message`) / `error_description`.

## 5. Response Structure

- Generation response: Gemini `candidates[]` style (`parts[]`, `text`, `thought` blocks, `functionCall`), parsed SSE event by event; additional `x-antigravity-*` metadata headers (token counts etc.).
- **Tool-call signature (protocol requirement, verified)**: outbound `functionCall` parts must carry a sibling `thoughtSignature` (400 "Function call is missing a thought_signature in functionCall parts" otherwise); the response-side functionCall part carries that signature (`{thoughtSignature, functionCall:{id,name,args}}`), which must be captured by `functionCall.id` and replayed on the next turn; when nothing is cached the `skip_thought_signature_validator` sentinel is used (both reference implementations default to it). Parallel functionCall signature semantics: see OmniRoute openai-to-gemini.ts.
- **Thoughts are not streamed (verified)**: `usageMetadata.thoughtsTokenCount` reports the thought-token count, but all models (gemini-3.6-flash-high / gemini-3-flash-agent / claude-opus-4-6-thinking / gemini-2.5-flash-thinking, incl. explicit `thinkingConfig`) stream **no `{thought:true}` parts** — thinking is either distilled into the final `text` (3.5 Flash family writes reasoning into the answer) or fully hidden (Claude family just outputs the answer). DSH front-end therefore shows no reasoning block; parse keeps thought-part support only defensively.
- `fetchAvailableModels`: `{models: Record<id, {quotaInfo?: {remainingFraction, resetTime}, displayName, modelName}>}`; **no capability metadata** (contextLength etc. must be filled from a local catalog); non-chat models present need filtering.
- **Image input (Gemini `inlineData` parts)**: the wrapped body is the Gemini Content proto JSON, so a user image block translates to `parts: [{inlineData: {mimeType, data}}]` with base64 bytes resolved from the DSH attachment service (`ctx.attachments.readImage`), no `data:` URL prefix. Media type comes from the attachment ref. Request-size caps come from the deployment's attachment limits; there is no per-request image offloading (a newer dsh-llm API would add it). The wire acceptance of `inlineData` is verified by the live probe `scripts/probe-image.mts` (one tiny PNG against a configured account). Images nested in tool results and assistant-side images are not representable and rejected up front (`UNSUPPORTED_CONTENT`); text-only catalog models (`gpt-oss-*`) reject images the same way.
- **Reasoning metadata**: for fixed models, thinking is fixed by the model id (`-thinking` / `-high` / `-medium` / `-low`), so `supportsReasoning` maps to a single fixed effort `on` (defaultEffort `on`). For dynamic tiered models (`gemini-3.7-flash-tiered` / `gemini-3.6-flash-tiered`), `supportsDynamicReasoning` exposes 4 selectable levels: `off` (0 budget), `low` (2048), `medium` (8192, default), and `high` (24576), which are materialized on the wire as `generationConfig.thinkingConfig.thinkingBudget` (with `maxOutputTokens` adjusted above the budget to avoid 400). Non-reasoning ids (`gemini-2.5-flash` etc.) get no reasoning control.
- Quota semantics: `loadCodeAssist`/`fetchAvailableModels` `quotaInfo` is the single quota source (no retrieveUserQuota/GeminiCLI UA path).
- **Implicit-cache reporting (verified)**: `usageMetadata.cachedContentTokenCount` is not always present — only reported once the cache is warmed and the prefix is large enough (gemini family ~16k+ prefix, hits from ~3rd request; claude family warms faster, can hit on 2nd request at ~99%). Single-turn/small-prefix requests always lack the field; that does not mean the model lacks caching. Test script `scripts/probe-cache-context.mts` (all three models reproduce: gemini-3.7-flash-tiered / gemini-3-flash-agent / claude-opus-4-6-thinking).
- **Cache key = prefix content, independent of sessionId (verified)**: `scripts/probe-cache-loss.mts` uses the same 20.5k system prefix byte-for-byte as an earlier probe with a fresh sessionId and hits 20447 tokens on the first round — the cache is shared across sessions by prefix hash. DSH's 0% on a new conversation's first round is really because the system prefix ~13.5k < 16k threshold (never cached) plus differing per-conversation history, not sessionId isolation.
- **Cache writes are async, ~2 rounds behind, batched by block (verified; root of the hit-rate ceiling)**: with byte-identical prefixes (append-only construction), `cached` still lags the previous full prompt each round — the hit prefix jumps by "the previous round's added block" (verified +4086 = one fill block per round), writes lag ~2 rounds; steady-state each round misses ≈ 1.5-2x the new additions -> hit-rate ceiling ~88-92%. Contrast DeepSeek's immediate full write (each round misses only the new content -> ~99%): this is why agy's hit rate can't reach 99%; upstream behavior, not controllable.
- Error-classification inputs: HTTP status + `Retry-After` / resetTime / error JSON shape -> runtime/classify. Generic 400s are `request-error` (permanent — retrying resends the same broken payload, so no rotation); only capacity-style 400s (context overflow / model unavailable) are transient.

## 6. Model Set

- Reference catalog: OmniRoute `AGY_PUBLIC_MODELS` (snapshot pinned from the live endpoint: gemini-3.6-flash-high/medium, Claude family, GPT family; includes contextLength/maxOutputTokens/supportsReasoning/supportsVision/toolCalling). **Correction vs. the snapshot**: the Gemini family is natively multimodal, so every `gemini-*` entry declares `supportsVision` (the snapshot under-reported the 2.5 Flash / 3.1 Flash Lite tier). `supportsVision` feeds DSH's `inputModalities` (image-capability annotation + image-admission gate), and `supportsReasoning` feeds the single-think control (see §5). Dynamic-only ids absent from the catalog stay unannotated (unknown, never text-only).
- Alias mapping references OmniRoute `antigravityModelAliases.ts` (only introduced if fixture testing finds id differences).
