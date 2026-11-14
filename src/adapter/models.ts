/**
 * Model discovery: dynamic `v1internal:fetchAvailableModels` as the primary
 * source (fresh ids + per-model quotaInfo), the pinned catalog merged in for
 * capability metadata, and catalog fallback when the endpoint is unreachable.
 */

import { createHash } from 'node:crypto'
import { ReasoningEffortId, type LlmModelInfo, type LlmModelReasoningInfo, type LlmResolvedModelInfo, type ModelModality } from '@deepseek-ai/dsh-llm'
import { AGY_ENDPOINT_FALLBACKS, getAgyBootstrapUserAgent } from '../oauth/constants.ts'
import { proxiedFetch } from '../proxy.ts'
import {
  AGY_PUBLIC_MODELS,
  catalogModel,
  clearDiscoveredUnifiedThinkingFamilies,
  discoveredUnifiedThinkingFamilyFor,
  discoveredUnifiedThinkingVariants,
  formatTieredModelName,
  isChatCallableModelId,
  isKnownUnifiedThinkingFamily,
  isLevelThinkingModel,
  isUnifiedThinkingFamily,
  levelThinkingEffortsFor,
  registerDiscoveredTieredModels,
  registerDiscoveredUnifiedThinkingFamily,
} from './catalog.ts'
import type { DiscreteThinkingLevel, DiscreteThinkingVariant } from './catalog.ts'
export { isUnifiedThinkingFamily } from './catalog.ts'

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
 * Only the explicit levels advertised for a discovered family are selectable alongside it.
 */
const EFFORT_NAMES: Readonly<Record<DiscreteThinkingLevel, string>> = {
  low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max',
}

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

// Keep only public capability metadata from the latest account's discovery, not
// quota or account information. Replaced as a unit on every catalog refresh.
let discoveredContextWindows = new Map<string, number>()

function discoveredContextWindow(modelId: string): number | undefined {
  // A concrete legacy ID can select sibling efforts too, so its budget must
  // account for every destination, not just its original concrete window.
  const family = discoveredUnifiedThinkingFamilyFor(modelId)
  if (!family) return discoveredContextWindows.get(modelId)
  const sizes = family.variants.map((variant) => discoveredContextWindows.get(variant.wireId))
  if (sizes.some((size) => size === undefined)) return undefined
  return Math.min(...sizes as number[])
}

function contextWindowFor(modelId: string, catalogWindow?: number): number | undefined {
  const discovered = discoveredContextWindow(modelId)
  return catalogWindow !== undefined && discovered !== undefined
    ? Math.min(catalogWindow, discovered)
    : catalogWindow ?? discovered
}

/** Role keys whose members are not agent chat models. */
const NON_CHAT_ROLE_KEYS = ['tabModelIds', 'imageGenerationModelIds', 'audioTranscriptionModelIds'] as const

/** The payload arrives via an unvalidated cast, so every shape is re-checked. */
function stringsFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

/** Keep only public model capabilities; no quota, credential, or account fields. */
function discoverySnapshot(dynamic: DiscoveredModels): DiscoveredModels {
  const models: Record<string, DiscoveredModelEntry> = Object.create(null)
  for (const [id, entry] of Object.entries(dynamic.models ?? {})) {
    if (!entry || typeof entry !== 'object') continue
    models[id] = {
      ...(typeof entry.displayName === 'string' ? { displayName: entry.displayName } : {}),
      ...(typeof entry.modelName === 'string' ? { modelName: entry.modelName } : {}),
      ...(typeof entry.maxTokens === 'number' ? { maxTokens: entry.maxTokens } : {}),
      ...(typeof entry.maxOutputTokens === 'number' ? { maxOutputTokens: entry.maxOutputTokens } : {}),
    }
  }
  const deprecatedModelIds: Record<string, DeprecatedModelInfo> = Object.create(null)
  for (const [id, info] of Object.entries(dynamic.deprecatedModelIds ?? {})) {
    if (info && typeof info.newModelId === 'string') deprecatedModelIds[id] = { newModelId: info.newModelId }
  }
  const tieredModelIds: Record<string, string[]> = Object.create(null)
  for (const [family, ids] of Object.entries(dynamic.tieredModelIds ?? {})) tieredModelIds[family] = stringsFrom(ids)
  return {
    models,
    tabModelIds: stringsFrom(dynamic.tabModelIds),
    imageGenerationModelIds: stringsFrom(dynamic.imageGenerationModelIds),
    audioTranscriptionModelIds: stringsFrom(dynamic.audioTranscriptionModelIds),
    deprecatedModelIds,
    ...(typeof dynamic.defaultAgentModelId === 'string' ? { defaultAgentModelId: dynamic.defaultAgentModelId } : {}),
    agentModelSorts: Array.isArray(dynamic.agentModelSorts) ? dynamic.agentModelSorts.map((sort) => ({
      ...(typeof sort?.displayName === 'string' ? { displayName: sort.displayName } : {}),
      groups: Array.isArray(sort?.groups) ? sort.groups.map((group) => ({ modelIds: stringsFrom(group?.modelIds) })) : [],
    })) : [],
    tieredModelIds,
  }
}

/** Last-known capabilities, isolated by opaque account scope and bounded in memory. */
export class ModelDiscoveryCache {
  private readonly snapshots = new Map<string, DiscoveredModels>()

  get(scope: string): DiscoveredModels | undefined { return this.snapshots.get(scope) }

  remember(scope: string, dynamic: DiscoveredModels): void {
    this.snapshots.delete(scope)
    this.snapshots.set(scope, discoverySnapshot(dynamic))
    if (this.snapshots.size > 32) this.snapshots.delete(this.snapshots.keys().next().value!)
  }

  forget(scope: string): void { this.snapshots.delete(scope) }
}

const defaultDiscoveryCache = new ModelDiscoveryCache()

/** An invalidated in-flight response must never replace the current account's catalog. */
export class StaleModelDiscoveryError extends Error {
  constructor() { super('model discovery was invalidated before completion') }
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
  // Discovery is account-scoped. Do not retain variants from the previous
  // account, and never synthesize a chat family out of hidden image/tab IDs.
  clearDiscoveredUnifiedThinkingFamilies()
  const splitFamilies = new Map<string, DiscreteThinkingVariant[]>()
  for (const id of Object.keys(models)) {
    if (!isChatCallableModelId(id) || hidden.has(id)) continue
    const match = /^(.*)-(low|medium|high|xhigh|max)$/.exec(id)
    if (!match?.[1] || !match[2]) continue
    const variants = splitFamilies.get(match[1]) ?? []
    variants.push({ effort: match[2] as DiscreteThinkingLevel, wireId: id })
    splitFamilies.set(match[1], variants)
  }
  for (const [base, variants] of splitFamilies) {
    const tiered = `${base}-tiered`
    const hasTiered = Object.hasOwn(models, tiered) && !hidden.has(tiered) && isChatCallableModelId(tiered)
    const hasNativeBase = Object.hasOwn(models, base) && !hidden.has(base)
      && isLevelThinkingModel(base) && !isUnifiedThinkingFamily(base)
    if (hasTiered || hasNativeBase) {
      const nativeEfforts = levelThinkingEffortsFor(hasTiered ? tiered : base)
      // Do not hide extra tiers the native selector cannot represent.
      for (const variant of variants) if (nativeEfforts.includes(variant.effort)) hidden.add(variant.wireId)
      continue
    }
    // If upstream explicitly marks the base as non-chat, grouping must not
    // resurrect it under a synthetic name.
    if (hidden.has(base)) continue
    if (variants.length < 2 && !isKnownUnifiedThinkingFamily(base)) continue
    registerDiscoveredUnifiedThinkingFamily(base, variants)
    for (const variant of variants) hidden.add(variant.wireId)
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

export function extractModelVersion(id: string): number {
  const match = /(\d+)(?:[-_.](\d+))?/.exec(id)
  if (!match || !match[1]) return 0
  const major = parseInt(match[1], 10)
  const minor = match[2] ? parseInt(match[2], 10) : 0
  return major + minor / Math.pow(10, match[2] ? match[2].length : 1)
}

/**
 * Model family rank used by the deterministic comparator:
 * Gemini (1) -> Claude (2) -> GPT (3) -> everything else (4).
 */
export function getModelFamilyRank(id: string): number {
  const lower = id.toLowerCase()
  if (lower.startsWith('gemini')) return 1
  if (lower.startsWith('claude')) return 2
  if (lower.startsWith('gpt')) return 3
  return 4
}

function getGeminiTierWeight(id: string): number {
  const lower = id.toLowerCase()
  if (lower.includes('pro') || lower.includes('ultra')) return 40
  if (lower.includes('argon')) return 30
  if (lower.includes('flash') && !lower.includes('lite') && !lower.includes('thinking')) return 30
  if (lower.includes('lite')) return 20
  if (lower.includes('thinking')) return 10
  return 25
}

function getGeminiRankScore(id: string): number {
  const ver = extractModelVersion(id)
  const tier = getGeminiTierWeight(id)
  // Gemini 3.x specific hierarchy: Standard Flash (3.8, 3.0) before Flash Lite (3.5, 3.1)
  if (ver >= 3.0 && ver < 4.0) {
    const isStandardFlash = id.includes('flash') && !id.includes('lite')
    if (isStandardFlash) {
      return 350 + (ver === 3 ? 1 : ver * 10)
    } else {
      return 300 + ver * 10
    }
  }
  return ver * 100 + tier
}

function getClaudeTierWeight(id: string): number {
  const lower = id.toLowerCase()
  if (lower.includes('opus')) return 30
  if (lower.includes('sonnet')) return 20
  if (lower.includes('haiku')) return 10
  return 15
}

function getClaudeRankScore(id: string): number {
  const ver = extractModelVersion(id)
  const tier = getClaudeTierWeight(id)
  return ver * 100 + tier
}

/**
 * Generalized, deterministic model comparator that sorts models into user-defined families
 * (Gemini -> Claude -> GPT -> Others), and prioritizes newer versions and higher capability tiers.
 * Automatically accommodates newly published upstream models without manual code changes.
 */
export function compareModels(a: { id: string }, b: { id: string }): number {
  const famA = getModelFamilyRank(a.id)
  const famB = getModelFamilyRank(b.id)
  if (famA !== famB) return famA - famB

  if (famA === 1) {
    const scoreA = getGeminiRankScore(a.id)
    const scoreB = getGeminiRankScore(b.id)
    if (scoreA !== scoreB) return scoreB - scoreA
  }

  if (famA === 2) {
    const scoreA = getClaudeRankScore(a.id)
    const scoreB = getClaudeRankScore(b.id)
    if (scoreA !== scoreB) return scoreB - scoreA
  }

  const verA = extractModelVersion(a.id)
  const verB = extractModelVersion(b.id)
  if (verA !== verB) return verB - verA

  return a.id.localeCompare(b.id)
}

/**
 * Detect whether upstream displayName contradicts the model ID version or characteristics.
 * E.g. Upstream returns "Gemini 3.5 Flash Lite" for "gemini-2.5-flash-lite", "gemini-2.5-flash",
 * or "gemini-2.5-flash-thinking".
 */
export function isUpstreamDisplayNameContradictory(id: string, upstreamName: string): boolean {
  const idVer = /(?:gemini|claude)[-_](\d+(?:\.\d+)?)/i.exec(id)?.[1]
  const nameVer = /(?:gemini|claude)\s+(\d+(?:\.\d+)?)/i.exec(upstreamName)?.[1]
  if (idVer && nameVer && idVer !== nameVer) {
    return true
  }
  if (!/lite/i.test(id) && /lite/i.test(upstreamName)) {
    return true
  }
  if (!/thinking/i.test(id) && /thinking/i.test(upstreamName)) {
    return true
  }
  return false
}

/** Merge dynamic ids with catalog metadata; non-chat and superseded ids are dropped, unknown ids keep minimal info. */
export function mergeModelCatalog(dynamic: DiscoveredModels): LlmModelInfo[] {
  if (dynamic.tieredModelIds) {
    registerDiscoveredTieredModels(dynamic.tieredModelIds)
  }
  const entries: LlmModelInfo[] = []
  const hidden = hiddenDiscoveredIds(dynamic)
  const contexts = new Map<string, number>()
  for (const [id, entry] of Object.entries(dynamic.models ?? {})) {
    if (!isChatCallableModelId(id) || (hidden.has(id) && !discoveredUnifiedThinkingFamilyFor(id))) continue
    const size = entry?.maxTokens
    if (typeof size === 'number' && Number.isSafeInteger(size) && size > 0) contexts.set(id, size)
  }
  discoveredContextWindows = contexts
  for (const [id, entry] of Object.entries(dynamic.models ?? {})) {
    if (!isChatCallableModelId(id) || hidden.has(id)) continue
    const meta = catalogModel(id)
    const rawDisplayName =
      entry.displayName && entry.displayName !== id && !isUpstreamDisplayNameContradictory(id, entry.displayName)
        ? entry.displayName
        : undefined
    const displayName =
      rawDisplayName ??
      meta?.name ??
      (entry.displayName && !isUpstreamDisplayNameContradictory(id, entry.displayName)
        ? entry.displayName
        : undefined) ??
      entry.modelName ??
      formatTieredModelName(id)
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
  // Ensure unified base models for split thinking families are present
  for (const splitId of Object.keys(dynamic.models ?? {})) {
    const m = /^(.*)-(?:low|medium|high|xhigh|max)$/.exec(splitId)
    if (m && m[1]) {
      const base = m[1]
      if (
        discoveredUnifiedThinkingVariants(base) !== undefined &&
        !entries.some((e) => e.id === base) &&
        !entries.some((e) => e.id === `${base}-tiered`)
      ) {
        const meta = catalogModel(base)
        const contextWindow = contextWindowFor(base, meta?.contextLength)
        entries.push({
          provider: AGY_PROVIDER,
          id: base,
          name: meta?.name ?? formatTieredModelName(base),
          inputModalities: inputModalitiesFor(meta),
          ...(contextWindow !== undefined ? { context: { contextWindow } } : {}),
        })
      }
    }
  }
  entries.sort(compareModels)
  return entries
}

/** Catalog-only model list used when the endpoint is unreachable. */
export function catalogModelList(): LlmModelInfo[] {
  clearDiscoveredUnifiedThinkingFamilies()
  discoveredContextWindows = new Map()
  const list = AGY_PUBLIC_MODELS.map((model) => ({
    provider: AGY_PROVIDER,
    id: model.id,
    name: model.name,
    inputModalities: inputModalitiesFor(model),
    context: { contextWindow: model.contextLength },
  }))
  list.sort(compareModels)
  return list
}

/** Adapter-facing listing: dynamic first, catalog fallback. */
export async function listAgyModels(
  accessToken: string | undefined,
  projectId: string | undefined,
  fetchImpl: typeof fetch = proxiedFetch,
  options: { cache?: ModelDiscoveryCache; scope?: string; isCurrent?: () => boolean } = {},
): Promise<readonly LlmModelInfo[]> {
  const ensureCurrent = () => { if (options.isCurrent?.() === false) throw new StaleModelDiscoveryError() }
  ensureCurrent()
  if (!accessToken) return catalogModelList()
  const cache = options.cache ?? defaultDiscoveryCache
  // Standalone callers have no account identity; a one-way token/project key
  // provides safe isolation without retaining the credential itself.
  const scope = options.scope ?? createHash('sha256').update(JSON.stringify([accessToken, projectId ?? null])).digest('hex')
  try {
    const dynamic = await fetchAvailableModels(accessToken, projectId, fetchImpl)
    ensureCurrent()
    const merged = mergeModelCatalog(dynamic)
    if (merged.length > 0) {
      cache.remember(scope, dynamic)
      return merged
    }
    // A successful empty response is authoritative, not a network failure.
    cache.forget(scope)
    return catalogModelList()
  } catch (error) {
    if (error instanceof StaleModelDiscoveryError) throw error
    ensureCurrent()
    const previous = cache.get(scope)
    if (previous) {
      const merged = mergeModelCatalog(previous)
      if (merged.length > 0) return merged
    }
    return catalogModelList()
  }
}

/** Resolve one exact model's metadata (catalog-backed; dynamic ids pass through). */
export function resolveAgyModel(provider: string, model: string): LlmResolvedModelInfo {
  const family = discoveredUnifiedThinkingFamilyFor(model)
  const meta = catalogModel(model) ?? (family ? catalogModel(family.base) : undefined)
  const contextWindow = contextWindowFor(model, meta?.contextLength)
  if (family || isLevelThinkingModel(model)) {
    const efforts = family ? family.variants.map((variant) => variant.effort) : levelThinkingEffortsFor(model)
    const reasoningInfo: LlmModelReasoningInfo = {
      efforts: efforts.map((effort) => ({ id: ReasoningEffortId(effort), name: EFFORT_NAMES[effort] })),
    }
    // Native tiered IDs retain the existing fallback. For an unpinned dynamic
    // family, do not invent a capacity that discovery did not report.
    const resolvedContext = contextWindow ?? (family ? undefined : 1048576)
    return {
      provider,
      id: model,
      name: meta?.name ?? model,
      inputModalities: inputModalitiesFor(meta),
      ...(resolvedContext !== undefined ? { context: { contextWindow: resolvedContext } } : {}),
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
    ...(contextWindow !== undefined ? { context: { contextWindow } } : {}),
    ...(meta ? { defaultMaxTokens: meta.maxOutputTokens } : {}),
  }
}
