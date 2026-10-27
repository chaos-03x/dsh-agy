/**
 * Model discovery: dynamic `v1internal:fetchAvailableModels` as the primary
 * source (fresh ids + per-model quotaInfo), the pinned catalog merged in for
 * capability metadata, and catalog fallback when the endpoint is unreachable.
 */

import { ReasoningEffortId, type LlmModelInfo, type LlmModelReasoningInfo, type LlmResolvedModelInfo, type ModelModality } from '@deepseek-ai/dsh-llm'
import { AGY_ENDPOINT_FALLBACKS, getAgyBootstrapUserAgent } from '../oauth/constants.ts'
import { proxiedFetch } from '../proxy.ts'
import {
  AGY_PUBLIC_MODELS,
  catalogModel,
  isChatCallableModelId,
  isLevelThinkingModel,
  levelThinkingEffortsFor,
  registerDiscoveredTieredModels,
} from './catalog.ts'

export const AGY_PROVIDER = 'agy'

/**
 * Selectable thinking levels for a tiered model. Deliberately NO `defaultEffort`.
 *
 * `defaultEffort` is not a display hint: the harness reads it as
 * `effective = requested ?? reasoning.defaultEffort`, and it also gates the
 * selector's own "provider default" entry
 * (`...reasoning.defaultEffort === void 0 ? [providerDefault] : []`). Setting it
 * therefore did two things at once — it forced an effort onto every request, so
 * `translate.ts` emitted `thinkingConfig` even when the user never chose a level,
 * and it REMOVED the only option that expresses "let the model decide".
 *
 * Leaving it unset restores that option (host label "Default"): choosing it
 * sends no `reasoningEffort`, `translate.ts` omits `thinkingConfig` entirely, and
 * the upstream runs its own adaptive budget — measured on this channel as
 * `thinkingBudget: -1` + `minThinkingBudget: 32` for every `*-tiered` model.
 * The three explicit levels remain selectable alongside it.
 */
const LEVEL_REASONING: LlmModelReasoningInfo = Object.freeze({
  efforts: Object.freeze([
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('medium'), name: 'Medium' },
    { id: ReasoningEffortId('high'), name: 'High' },
  ] as const),
} as const)

/** Reasoning levels for the Pro family (Low and High only; no Medium tier). */
const PRO_LEVEL_REASONING: LlmModelReasoningInfo = Object.freeze({
  efforts: Object.freeze([
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('high'), name: 'High' },
  ] as const),
} as const)

/**
 * Input modalities per model. Image support follows the catalog's own
 * `supportsVision` metadata for known models (gpt-oss-120b-medium is text-only
 * there); unknown dynamic ids default to vision-capable — the upstream schema
 * accepts inlineData across the board, and a wrong guess surfaces as a clear
 * upstream 400 instead of a silent drop.
 */
const AGY_INPUT_MODALITIES = ['text', 'image'] as const
const AGY_TEXT_ONLY_MODALITIES = ['text'] as const

function inputModalitiesFor(meta: { supportsVision?: boolean } | undefined): ModelModality[] {
  return [...(meta ? meta.supportsVision === true : true) ? AGY_INPUT_MODALITIES : AGY_TEXT_ONLY_MODALITIES]
}

export interface DiscoveredModelEntry {
  quotaInfo?: {
    remainingFraction?: number
    resetTime?: string
  }
  displayName?: string
  modelName?: string
  maxTokens?: number
  maxOutputTokens?: number
}

export interface DeprecatedModelInfo {
  newModelId?: string
  oldModelEnum?: string
  newModelEnum?: string
}

export interface DiscoveredModels {
  models?: Record<string, DiscoveredModelEntry>
  /**
   * Role assignments the endpoint returns alongside `models`. Upstream uses
   * them to decide which id drives which IDE feature; only the ones that mean
   * "this is not an agent chat model" are consumed here, plus the three
   * positive signals below.
   */
  tabModelIds?: string[]
  imageGenerationModelIds?: string[]
  audioTranscriptionModelIds?: string[]
  /** Keyed by the RETIRED id; an object, not an array. */
  deprecatedModelIds?: Record<string, DeprecatedModelInfo>
  defaultAgentModelId?: string
  agentModelSorts?: { displayName?: string; groups?: { modelIds?: string[] }[] }[]
  /** Selectable-thinking families, e.g. `{flash: ['gemini-3.8-flash-tiered']}`. */
  tieredModelIds?: Record<string, string[]>
}

/** Role keys whose members are not agent chat models. */
const NON_CHAT_ROLE_KEYS = ['tabModelIds', 'imageGenerationModelIds', 'audioTranscriptionModelIds'] as const

/** The payload arrives via an unvalidated cast, so every shape is re-checked. */
function stringsFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

/**
 * Ids the payload itself advertises: the default agent model, anything in an
 * `agentModelSorts` group, and every tiered family member. These are never
 * hidden. If upstream both recommends an id and files it under a non-chat
 * role, the recommendation is the more recent statement of intent, and this
 * keeps a labelling mistake from removing a working model.
 */
function advertisedModelIds(dynamic: DiscoveredModels): Set<string> {
  const advertised = new Set<string>()
  if (typeof dynamic.defaultAgentModelId === 'string' && dynamic.defaultAgentModelId.length > 0) {
    advertised.add(dynamic.defaultAgentModelId)
  }
  for (const sort of Array.isArray(dynamic.agentModelSorts) ? dynamic.agentModelSorts : []) {
    for (const group of Array.isArray(sort?.groups) ? sort.groups : []) {
      for (const id of stringsFrom(group?.modelIds)) advertised.add(id)
    }
  }
  const tiered = dynamic.tieredModelIds
  if (tiered && typeof tiered === 'object' && !Array.isArray(tiered)) {
    for (const family of Object.values(tiered)) {
      for (const id of stringsFrom(family)) advertised.add(id)
    }
  }
  return advertised
}

/**
 * Discovered ids that should not appear in a chat model list, according to the
 * payload's own role assignments.
 *
 * This is the judgement `isChatCallableModelId` already makes with the `tab_`
 * prefix, but taken from upstream's list instead of a name guess. That matters:
 * `tabModelIds` members are not required to start with `tab_` (live accounts
 * return ids such as `chat_20706`), so those ids would otherwise reach the
 * model list, where they render as a raw id with no metadata.
 *
 * Only roles that mean "different output modality" or "superseded" are
 * consumed. The utility roles (`commandModelIds`, `mqueryModelIds`,
 * `webSearchModelIds`, `commitMessageModelIds`) name ordinary chat models doing
 * a side job - on a live account all three of the latter name
 * `gemini-3.1-flash-lite`, which is a pinned catalog model.
 *
 * A deprecated id is hidden only when its `newModelId` is present in `models`,
 * chat-callable, and not role-hidden; otherwise hiding it would remove the only
 * route to that capability on an account whose tier does not carry the
 * replacement. Replacement availability is judged against role hiding alone and
 * never against other deprecations, so a chain A -> B -> C resolves the same
 * way whatever order the payload happens to serialize its keys in.
 *
 * Not the complete hiding rule: the `tab_` prefix check stays in
 * `mergeModelCatalog`, because the catalog-only fallback has no payload.
 */
function hiddenDiscoveredIds(dynamic: DiscoveredModels): Set<string> {
  const models = dynamic.models ?? {}
  const advertised = advertisedModelIds(dynamic)
  const hidden = new Set<string>()
  for (const key of NON_CHAT_ROLE_KEYS) {
    for (const id of stringsFrom(dynamic[key])) {
      if (!advertised.has(id)) hidden.add(id)
    }
  }
  const roleHidden = new Set(hidden)
  const deprecated = dynamic.deprecatedModelIds
  if (deprecated && typeof deprecated === 'object' && !Array.isArray(deprecated)) {
    for (const [retiredId, info] of Object.entries(deprecated)) {
      if (advertised.has(retiredId)) continue
      const replacement = info?.newModelId
      if (typeof replacement !== 'string' || replacement.length === 0 || replacement === retiredId) continue
      if (!Object.hasOwn(models, replacement)) continue
      if (!isChatCallableModelId(replacement) || roleHidden.has(replacement)) continue
      hidden.add(retiredId)
    }
  }
  for (const id of Object.keys(models)) {
    const m = /^(.*)-(?:low|medium|high)$/.exec(id)
    if (m && Object.hasOwn(models, `${m[1]}-tiered`)) hidden.add(id)
  }
  return hidden
}

/** Fetch the account's available models from the first reachable endpoint. */
export async function fetchAvailableModels(
  accessToken: string,
  projectId?: string,
  fetchImpl: typeof fetch = proxiedFetch,
): Promise<DiscoveredModels> {
  let lastError: unknown = null
  const body = projectId ? { project: projectId } : {}
  for (const baseEndpoint of AGY_ENDPOINT_FALLBACKS) {
    try {
      const response = await fetchImpl(`${baseEndpoint}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': getAgyBootstrapUserAgent(),
        },
        body: JSON.stringify(body),
      })
      if (response.ok) {
        return (await response.json()) as DiscoveredModels
      }
      lastError = new Error(`fetchAvailableModels ${response.status} at ${baseEndpoint}`)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('fetchAvailableModels: all endpoints failed')
}

/**
 * The discovered ids a chat session may actually use: upstream's `models` minus
 * the `tab_`/role/deprecated set (see `hiddenDiscoveredIds`).
 *
 * Exported so surfaces other than the selector (the quota panel) present the
 * same list. `mergeModelCatalog` consumes it too, so the two cannot drift.
 */
export function chatCallableDiscoveredIds(dynamic: DiscoveredModels): string[] {
  const hidden = hiddenDiscoveredIds(dynamic)
  return Object.keys(dynamic.models ?? {}).filter((id) => isChatCallableModelId(id) && !hidden.has(id))
}

/** Merge dynamic ids with catalog metadata; non-chat and superseded ids are dropped, unknown ids keep minimal info. */
export function mergeModelCatalog(dynamic: DiscoveredModels): LlmModelInfo[] {
  if (dynamic.tieredModelIds) {
    registerDiscoveredTieredModels(dynamic.tieredModelIds)
  }
  const entries: LlmModelInfo[] = []
  const hidden = hiddenDiscoveredIds(dynamic)
  for (const [id, entry] of Object.entries(dynamic.models ?? {})) {
    if (!isChatCallableModelId(id) || hidden.has(id)) continue
    const meta = catalogModel(id)
    const rawDisplayName = entry.displayName && entry.displayName !== id ? entry.displayName : undefined
    const displayName = rawDisplayName ?? meta?.name ?? entry.displayName ?? entry.modelName ?? id
    const contextWindow =
      meta?.contextLength ??
      (typeof entry.maxTokens === 'number' && entry.maxTokens > 0 ? entry.maxTokens : undefined)
    entries.push({
      provider: AGY_PROVIDER,
      id,
      name: displayName,
      inputModalities: inputModalitiesFor(meta),
      ...(contextWindow !== undefined ? { context: { contextWindow } } : {}),
    })
  }
  return entries
}

/** Catalog-only model list used when the endpoint is unreachable. */
export function catalogModelList(): LlmModelInfo[] {
  return AGY_PUBLIC_MODELS.map((model) => ({
    provider: AGY_PROVIDER,
    id: model.id,
    name: model.name,
    inputModalities: inputModalitiesFor(model),
    context: { contextWindow: model.contextLength },
  }))
}

/** Adapter-facing listing: dynamic first, catalog fallback. */
export async function listAgyModels(
  accessToken: string | undefined,
  projectId: string | undefined,
  fetchImpl: typeof fetch = proxiedFetch,
  poolModelIds?: readonly string[],
): Promise<readonly LlmModelInfo[]> {
  if (!accessToken) return catalogModelList()
  try {
    const dynamic = await fetchAvailableModels(accessToken, projectId, fetchImpl)
    if (poolModelIds && poolModelIds.length > 0) {
      if (!dynamic.models) dynamic.models = {}
      for (const id of poolModelIds) {
        if (!dynamic.models[id]) {
          dynamic.models[id] = {}
        }
      }
    }
    const merged = mergeModelCatalog(dynamic)
    return merged.length > 0 ? merged : catalogModelList()
  } catch {
    return catalogModelList()
  }
}

/** Resolve one exact model's metadata (catalog-backed; dynamic ids pass through). */
export function resolveAgyModel(provider: string, model: string): LlmResolvedModelInfo {
  const meta = catalogModel(model)
  if (isLevelThinkingModel(model)) {
    const efforts = levelThinkingEffortsFor(model)
    const reasoningInfo: LlmModelReasoningInfo = efforts.length === 2
      ? { ...PRO_LEVEL_REASONING, efforts: [...PRO_LEVEL_REASONING.efforts] }
      : { ...LEVEL_REASONING, efforts: [...LEVEL_REASONING.efforts] }
    return {
      provider,
      id: model,
      name: meta?.name ?? model,
      inputModalities: inputModalitiesFor(meta),
      context: { contextWindow: meta?.contextLength ?? 1048576 },
      defaultMaxTokens: meta?.maxOutputTokens ?? 65536,
      // Return a shallow copy so callers cannot mutate the frozen singleton.
      reasoning: reasoningInfo,
    }
  }
  return {
    provider,
    id: model,
    name: meta?.name ?? model,
    inputModalities: inputModalitiesFor(meta),
    ...(meta ? { context: { contextWindow: meta.contextLength }, defaultMaxTokens: meta.maxOutputTokens } : {}),
  }
}
