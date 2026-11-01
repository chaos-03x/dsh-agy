/**
 * Model routing targets for tiered model families.
 *
 * Split out so browser UI and RPC contract can import without pulling in
 * node:* modules.
 */

export const MODEL_ROUTING_VERSION = 1

export type ModelRoutingTarget = 'tiered' | 'high' | 'medium' | 'low'

export const MODEL_ROUTING_TARGETS: readonly ModelRoutingTarget[] = [
  'tiered',
  'high',
  'medium',
  'low',
] as const

export const DEFAULT_MODEL_ROUTING_TARGET: ModelRoutingTarget = 'tiered'

export interface ModelRoutingDocument {
  version: 1
  target?: ModelRoutingTarget
}

export type ModelRoutingSource = 'default' | 'stored' | 'env'

export interface ModelRoutingView {
  target: ModelRoutingTarget
  source: ModelRoutingSource
}

export function isValidModelRoutingTarget(value: unknown): value is ModelRoutingTarget {
  return typeof value === 'string' && (MODEL_ROUTING_TARGETS as readonly string[]).includes(value)
}

/**
 * Route a requested model to its target variant according to the configured routing target.
 *
 * Tiered models (ending in `-tiered`) are routed to `${base}-${target}` when a
 * non-default target is configured ('high' | 'medium' | 'low').
 * When target is 'tiered' (default), or the model is not a tiered model,
 * it is left unchanged.
 */
export function routeModel(model: string, target: ModelRoutingTarget = DEFAULT_MODEL_ROUTING_TARGET): string {
  if (!model) return model
  if (target === 'tiered') return model
  const match = /^(.*)-tiered$/.exec(model)
  if (!match) return model
  const base = match[1]!
  return `${base}-${target}`
}
