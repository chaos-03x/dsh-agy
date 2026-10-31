/**
 * Pinned agy model catalog (metadata only — dynamic discovery is primary).
 *
 * Adapted from OmniRoute's `AGY_PUBLIC_MODELS` (MIT, see NOTICE.md), which was
 * pinned from the live `v1internal:fetchAvailableModels` endpoint. The dynamic
 * endpoint supplies ids + quotaInfo; this catalog supplies the capability
 * metadata the endpoint omits (context length, output cap, reasoning/vision/
 * tool-calling). Tab-completion models are intentionally excluded.
 */

export interface CatalogModel {
  id: string
  name: string
  contextLength: number
  maxOutputTokens: number
  supportsReasoning?: boolean
  supportsVision?: boolean
  toolCalling?: boolean
  /** Level-thinking: 'level' means single id + selectable low/medium/high via thinkingLevel. Omit = level bound to id. */
  thinking?: 'level'
  /** The reasoning levels this model exposes when thinking is 'level' (default: low/medium/high). */
  thinkingLevels?: readonly ('low' | 'medium' | 'high')[]
}

export const AGY_PUBLIC_MODELS: readonly CatalogModel[] = [
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true, thinking: 'level' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextLength: 200000, maxOutputTokens: 64000, supportsReasoning: true, supportsVision: true, toolCalling: true, thinking: 'level' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', contextLength: 200000, maxOutputTokens: 64000, supportsReasoning: true, supportsVision: true, toolCalling: true, thinking: 'level' },
  { id: 'gemini-3.8-flash-tiered', name: 'Gemini 3.8 Flash', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true, thinking: 'level', thinkingLevels: ['low', 'medium', 'high'] as const },
  { id: 'gemini-3.7-flash-tiered', name: 'Gemini 3.7 Flash', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true, thinking: 'level', thinkingLevels: ['low', 'medium', 'high'] as const },
  { id: 'gemini-3.6-flash-tiered', name: 'Gemini 3.6 Flash (Tiered)', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true, thinking: 'level', thinkingLevels: ['low', 'medium', 'high'] as const },
  { id: 'gemini-3.6-flash-high', name: 'Gemini 3.6 Flash (High)', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'gemini-3.6-flash-medium', name: 'Gemini 3.6 Flash (Medium)', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true },
  // Claude family: this channel rejects maxOutputTokens above 64000 for these
  // ids (64001+ -> 400 INVALID_ARGUMENT; 64000 passes). Measured, not derived
  // from Anthropic's public limits — see translate.ts AGY_CLAUDE_MAX_OUTPUT_TOKENS.
  // This value is the harness-injected default, so it must stay at or under the
  // cap or every Claude request fails.
  { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)', contextLength: 1048576, maxOutputTokens: 64000, supportsReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)', contextLength: 1048576, maxOutputTokens: 64000, supportsReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'gemini-pro-agent', name: 'Gemini 3.1 Pro (High)', contextLength: 1048576, maxOutputTokens: 65535, supportsReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (Low)', contextLength: 1048576, maxOutputTokens: 65535, supportsReasoning: true, supportsVision: true, toolCalling: true, thinking: 'level', thinkingLevels: ['low', 'high'] as const },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextLength: 1048576, maxOutputTokens: 65535, supportsVision: true, toolCalling: true },
  { id: 'gemini-3-flash-agent', name: 'Gemini 3.5 Flash (High)', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'gemini-3.5-flash-low', name: 'Gemini 3.5 Flash (Medium)', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'gemini-3.5-flash-extra-low', name: 'Gemini 3.5 Flash (Low)', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', contextLength: 1048576, maxOutputTokens: 65535, supportsVision: true, toolCalling: true },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', contextLength: 1048576, maxOutputTokens: 65535, supportsVision: true, toolCalling: true },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', contextLength: 1048576, maxOutputTokens: 65535, supportsVision: true, toolCalling: true },
  { id: 'gemini-2.5-flash-thinking', name: 'Gemini 2.5 Flash Thinking', contextLength: 1048576, maxOutputTokens: 65535, supportsReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextLength: 1048576, maxOutputTokens: 65535, supportsVision: true, toolCalling: true },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', contextLength: 1048576, maxOutputTokens: 65535, supportsVision: true, toolCalling: true },
  { id: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'gemini-4-argon-low', name: 'Gemini 4 Argon (Low)', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)', contextLength: 131072, maxOutputTokens: 32768, supportsReasoning: true, toolCalling: true },
]

const CATALOG_BY_ID = new Map(AGY_PUBLIC_MODELS.map((m) => [m.id, m]))

/** Format dynamic tiered model id to display name (e.g. 'gemini-3.8-flash-tiered' -> 'Gemini 3.8 Flash'). */
export function formatTieredModelName(modelId: string): string {
  const base = modelId.replace(/-tiered$/, '')
  return base
    .split('-')
    .map((part) => {
      if (/^\d+(\.\d+)*$/.test(part)) return part
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(' ')
}

/**
 * Ids the picker must not offer: tab-completion helpers and the per-tab session
 * ids that ride the same role lists.
 *
 * Both shapes are discoverable — they appear in \`models\` — but neither is an
 * agent chat model. The \`tab_\` prefix is the older shape; \`chat_<digits>\` is
 * the live one (\`chat_20706\`), and upstream names those under \`tabModelIds\`
 * rather than by prefix, so an account whose discovery omits the role list would
 * otherwise render a raw id with no metadata. Deciding it from the id here keeps
 * the catalog-only fallback and the role-based hiding in agreement.
 */
export function isChatCallableModelId(modelId: string): boolean {
  return !modelId.startsWith('tab_') && !/^chat_\d+$/.test(modelId) && !modelId.endsWith('-disabled')
}

export function catalogModel(modelId: string): CatalogModel | undefined {
  const existing = CATALOG_BY_ID.get(modelId)
  if (existing) return existing
  if (typeof modelId === 'string' && modelId.endsWith('-tiered')) {
    return {
      id: modelId,
      name: formatTieredModelName(modelId),
      contextLength: 1048576,
      maxOutputTokens: 65536,
      supportsReasoning: true,
      supportsVision: true,
      toolCalling: true,
      thinking: 'level',
    }
  }
  return undefined
}

/** Dynamically discovered tiered models and their family ('flash', 'pro', 'flashLite', etc.). */
const DISCOVERED_TIERED_FAMILIES = new Map<string, string>()

/**
 * Priority ranking for tiered model families.
 *
 * Specific feature families (flash, flashLite) take precedence over the generic 'pro'
 * grouping when upstream redundantly lists a model under multiple categories
 * (e.g. Google's fetchAvailableModels returns gemini-3.8-flash-tiered in both flash and pro).
 */
const TIERED_FAMILY_PRECEDENCE: Readonly<Record<string, number>> = Object.freeze({
  flash: 10,
  flashlite: 10,
  pro: 1,
})

/**
 * Register tiered models advertised by `fetchAvailableModels`'s `tieredModelIds`.
 *
 * Upstream groups tiered models by family (e.g. `{ flash: [...], pro: ['gemini-3.1-pro-low'], flashLite: [...] }`).
 * Specificity precedence ensures high-capability families are preserved when upstream has group overlap.
 */
export function registerDiscoveredTieredModels(tiered?: Record<string, string[]> | null): void {
  if (!tiered || typeof tiered !== 'object' || Array.isArray(tiered)) return
  for (const [family, ids] of Object.entries(tiered)) {
    if (!Array.isArray(ids)) continue
    const lowerFamily = family.toLowerCase()
    const newPrecedence = TIERED_FAMILY_PRECEDENCE[lowerFamily] ?? 5
    for (const id of ids) {
      if (typeof id === 'string' && id.length > 0) {
        const existingFamily = DISCOVERED_TIERED_FAMILIES.get(id)
        const existingPrecedence = existingFamily ? (TIERED_FAMILY_PRECEDENCE[existingFamily] ?? 5) : 0
        if (newPrecedence >= existingPrecedence) {
          DISCOVERED_TIERED_FAMILIES.set(id, lowerFamily)
        }
      }
    }
  }
}

const DISCOVERED_UNIFIED_THINKING_FAMILIES = new Set<string>()

/** Register dynamically discovered unified thinking families (e.g. models with discrete -low/-medium/-high variants). */
export function registerDiscoveredUnifiedThinkingFamily(baseId: string): void {
  DISCOVERED_UNIFIED_THINKING_FAMILIES.add(baseId)
}

/** Check whether a model ID is a unified thinking family (known static or dynamically discovered). */
export function isUnifiedThinkingFamily(modelId: string): boolean {
  return (
    modelId === 'gemini-4-argon' ||
    modelId === 'claude-opus-5-5' ||
    modelId === 'claude-sonnet-5-5' ||
    DISCOVERED_UNIFIED_THINKING_FAMILIES.has(modelId)
  )
}

/** Reset discovered tiered models (used by test suites). */
export function resetDiscoveredTieredModels(): void {
  DISCOVERED_TIERED_FAMILIES.clear()
  DISCOVERED_UNIFIED_THINKING_FAMILIES.clear()
}

/**
 * Level-thinking models: a single id with selectable tiers via `thinkingLevel`.
 *
 * Consults dynamically discovered `tieredModelIds` first, falling back to the catalog's
 * explicit `thinking: 'level'` metadata, unified thinking families, and legacy `-tiered` suffix.
 */
export function isLevelThinkingModel(modelId: string): boolean {
  if (catalogModel(modelId)?.thinking === 'level') return true
  if (DISCOVERED_TIERED_FAMILIES.has(modelId)) return true
  if (typeof modelId === 'string') {
    if (modelId.endsWith('-tiered')) return true
    if (isUnifiedThinkingFamily(modelId)) return true
  }
  return false
}

/**
 * The reasoning levels supported by a level-thinking model.
 *
 * Flash family exposes low/medium/high; Pro family exposes low/high only
 * (measured: Pro models reject medium thinking levels).
 */
export function levelThinkingEffortsFor(modelId: string): readonly ('low' | 'medium' | 'high')[] {
  const cat = catalogModel(modelId)
  if (cat?.thinkingLevels) return cat.thinkingLevels
  const family = DISCOVERED_TIERED_FAMILIES.get(modelId)
  if (family === 'pro') return ['low', 'high']
  return ['low', 'medium', 'high']
}
