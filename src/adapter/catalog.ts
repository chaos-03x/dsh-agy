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
}

export const AGY_PUBLIC_MODELS: readonly CatalogModel[] = [
  { id: 'gemini-3.8-flash-tiered', name: 'Gemini 3.8 Flash', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true, thinking: 'level' },
  { id: 'gemini-3.7-flash-tiered', name: 'Gemini 3.7 Flash', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true, thinking: 'level' },
  { id: 'gemini-3.6-flash-tiered', name: 'Gemini 3.6 Flash (Tiered)', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true, thinking: 'level' },
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
  { id: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (Low)', contextLength: 1048576, maxOutputTokens: 65535, supportsReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'gemini-3-flash-agent', name: 'Gemini 3.5 Flash (High)', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'gemini-3.5-flash-low', name: 'Gemini 3.5 Flash (Medium)', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'gemini-3.5-flash-extra-low', name: 'Gemini 3.5 Flash (Low)', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', contextLength: 1048576, maxOutputTokens: 65535, supportsVision: true, toolCalling: true },
  { id: 'gemini-2.5-flash-thinking', name: 'Gemini 2.5 Flash Thinking', contextLength: 1048576, maxOutputTokens: 65535, supportsReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextLength: 1048576, maxOutputTokens: 65535, supportsVision: true, toolCalling: true },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', contextLength: 1048576, maxOutputTokens: 65535, supportsVision: true, toolCalling: true },
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
  return !modelId.startsWith('tab_') && !/^chat_\d+$/.test(modelId)
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

/**
 * Level-thinking models: a single id with selectable tiers via `thinkingLevel`.
 *
 * KNOWN GAP (tracked in issue #47, with the measurements): upstream publishes the
 * authoritative grouping as `tieredModelIds` in every `fetchAvailableModels`
 * response — `{ flashLite: [...], flash: [...], pro: ['gemini-3.1-pro-low'] }` —
 * and this rule ignores it. The `-tiered` suffix is a NAMING COINCIDENCE that
 * happens to hold for the three Flash ids, so:
 *   - upstream-tiered `gemini-3.1-pro-low` (which does accept `thinkingLevel`,
 *     measured) is treated as id-bound and never shows a tier selector;
 *   - a tiered model added under any other name is silently excluded — no log,
 *     no warning, it simply appears without tiers.
 * The fix is to consult `tieredModelIds` with this function as the offline
 * fallback, and to let the budget card render the tiers a family actually has
 * (Flash: low/medium/high; Pro: low/high only).
 */
export function isLevelThinkingModel(modelId: string): boolean {
  if (catalogModel(modelId)?.thinking === 'level') return true
  return typeof modelId === 'string' && modelId.endsWith('-tiered')
}
