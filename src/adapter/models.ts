/**
 * Model discovery: dynamic `v1internal:fetchAvailableModels` as the primary
 * source (fresh ids + per-model quotaInfo), the pinned catalog merged in for
 * capability metadata, and catalog fallback when the endpoint is unreachable.
 */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo, ModelModality } from '@deepseek-ai/dsh-llm'
import { AGY_ENDPOINT_FALLBACKS, getAgyBootstrapUserAgent } from '../oauth/constants.ts'
import { proxiedFetch } from '../proxy.ts'
import { AGY_PUBLIC_MODELS, catalogModel, isChatCallableModelId } from './catalog.ts'
import type { CatalogModel } from './catalog.ts'

export const AGY_PROVIDER = 'agy'

export interface DiscoveredModelEntry {
  quotaInfo?: {
    remainingFraction?: number
    resetTime?: string
  }
  displayName?: string
  modelName?: string
}

export interface DiscoveredModels {
  models?: Record<string, DiscoveredModelEntry>
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
 * Declared input modalities for one catalog entry.
 *
 * Absent (undefined) means "unknown", not "text-only": a dynamic-only model id
 * that is not in the catalog gets no declaration, so a newer multimodal model
 * stays usable without DSH stripping or rejecting its images. A catalog-known
 * entry is declared explicitly — the DSH runtime rejects image attachment for
 * text-only models and projects their image blocks out, so the declaration
 * must match what the adapter can actually transmit (see translate.ts).
 */
function modalitiesOf(meta: CatalogModel | undefined): readonly ModelModality[] | undefined {
  if (meta === undefined) return undefined
  return meta.supportsVision ? ['text', 'image'] : ['text']
}

const DYNAMIC_REASONING_EFFORTS = [
  { id: ReasoningEffortId('off'), name: 'Off', description: 'Disable extended thinking (0 tokens)' },
  { id: ReasoningEffortId('low'), name: 'Low', description: 'Light reasoning (~2k tokens)' },
  { id: ReasoningEffortId('medium'), name: 'Medium', description: 'Standard reasoning (~8k tokens)' },
  { id: ReasoningEffortId('high'), name: 'High', description: 'Deep reasoning (~24k tokens)' },
] as const

/**
 * Selectable reasoning efforts for one catalog entry, or nothing at all.
 *
 * For tiered dynamic models (`gemini-3.7-flash-tiered` / `gemini-3.6-flash-tiered`),
 * extended thinking can be tuned or disabled per-request via `thinkingConfig.thinkingBudget`
 * (Off: 0, Low: 2048, Medium: 8192, High: 24576).
 *
 * For fixed models (`-thinking`, `-high/-medium/-low`), thinking is baked into the model id,
 * so the only truthful level is a fixed "on".
 *
 * A model without `supportsReasoning` (e.g. `gemini-2.5-flash`) gets no reasoning control.
 */
function reasoningOf(meta: CatalogModel | undefined): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (meta?.supportsReasoning !== true) return {}
  if (meta.supportsDynamicReasoning) {
    return {
      reasoning: {
        efforts: DYNAMIC_REASONING_EFFORTS,
        defaultEffort: ReasoningEffortId('medium'),
      },
    }
  }
  return {
    reasoning: {
      efforts: [{
        id: ReasoningEffortId('on'),
        name: 'Thinking',
        description: 'Thinking is fixed by the model id; no per-request level.',
      }],
      defaultEffort: ReasoningEffortId('on'),
    },
  }
}

/** Merge dynamic ids with catalog metadata; non-chat models and unknowns keep minimal info. */
export function mergeModelCatalog(dynamic: DiscoveredModels): LlmModelInfo[] {
  const entries: LlmModelInfo[] = []
  for (const [id, entry] of Object.entries(dynamic.models ?? {})) {
    if (!isChatCallableModelId(id)) continue
    const meta = catalogModel(id)
    const modalities = modalitiesOf(meta)
    entries.push({
      provider: AGY_PROVIDER,
      id,
      name: entry.displayName ?? meta?.name ?? entry.modelName ?? id,
      ...(modalities === undefined ? {} : { inputModalities: modalities }),
      ...(meta ? { context: { contextWindow: meta.contextLength } } : {}),
    })
  }
  return entries
}

/** Catalog-only model list used when the endpoint is unreachable. */
export function catalogModelList(): LlmModelInfo[] {
  return AGY_PUBLIC_MODELS.map((model) => {
    const modalities = modalitiesOf(model)
    return {
      provider: AGY_PROVIDER,
      id: model.id,
      name: model.name,
      ...(modalities === undefined ? {} : { inputModalities: modalities }),
      context: { contextWindow: model.contextLength },
    }
  })
}

/** Adapter-facing listing: dynamic first, catalog fallback. */
export async function listAgyModels(
  accessToken: string | undefined,
  projectId: string | undefined,
  fetchImpl: typeof fetch = proxiedFetch,
): Promise<readonly LlmModelInfo[]> {
  if (!accessToken) return catalogModelList()
  try {
    const dynamic = await fetchAvailableModels(accessToken, projectId, fetchImpl)
    const merged = mergeModelCatalog(dynamic)
    return merged.length > 0 ? merged : catalogModelList()
  } catch {
    return catalogModelList()
  }
}

/** Resolve one exact model's metadata (catalog-backed; dynamic ids pass through). */
export function resolveAgyModel(provider: string, model: string): LlmResolvedModelInfo {
  const meta = catalogModel(model)
  const modalities = modalitiesOf(meta)
  return {
    provider,
    id: model,
    name: meta?.name ?? model,
    ...(modalities === undefined ? {} : { inputModalities: modalities }),
    ...(meta ? { context: { contextWindow: meta.contextLength }, defaultMaxTokens: meta.maxOutputTokens } : {}),
    ...reasoningOf(meta),
  }
}
