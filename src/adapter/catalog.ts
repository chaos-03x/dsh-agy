/**
 * Pinned agy model catalog (metadata only — dynamic discovery is primary).
 *
 * Adapted from OmniRoute's `AGY_PUBLIC_MODELS` (MIT, see NOTICE.md), which was
 * pinned from the live `v1internal:fetchAvailableModels` endpoint. The dynamic
 * endpoint supplies ids + quotaInfo; this catalog supplies the capability
 * metadata the endpoint omits (context length, output cap, reasoning/vision/
 * tool-calling). Tab-completion models are intentionally excluded.
 *
 * Correction vs. the OmniRoute snapshot: the Gemini family is natively
 * multimodal, so every `gemini-*` entry declares `supportsVision` (the
 * snapshot under-reported it for the 2.5 Flash / 3.1 Flash Lite tier).
 */

export interface CatalogModel {
  id: string
  name: string
  contextLength: number
  maxOutputTokens: number
  supportsReasoning?: boolean
  /** Whether the model supports dynamic thinkingBudget tiers (Off / Low / Medium / High). */
  supportsDynamicReasoning?: boolean
  supportsVision?: boolean
  toolCalling?: boolean
}

export const AGY_PUBLIC_MODELS: readonly CatalogModel[] = [
  { id: 'gemini-3.7-flash-tiered', name: 'Gemini 3.7 Flash', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsDynamicReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'gemini-3.6-flash-tiered', name: 'Gemini 3.6 Flash (Tiered)', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsDynamicReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'gemini-3.6-flash-high', name: 'Gemini 3.6 Flash (High)', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'gemini-3.6-flash-medium', name: 'Gemini 3.6 Flash (Medium)', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)', contextLength: 1048576, maxOutputTokens: 65536, supportsReasoning: true, supportsVision: true, toolCalling: true },
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

/** Tab-completion models are discoverable but not chat-callable. */
export function isChatCallableModelId(modelId: string): boolean {
  return !modelId.startsWith('tab_')
}

export function catalogModel(modelId: string): CatalogModel | undefined {
  return CATALOG_BY_ID.get(modelId)
}
