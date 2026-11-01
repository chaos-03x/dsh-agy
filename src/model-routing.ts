/**
 * Model routing configuration persistence: `$DSH_HOME/agy/agy-model-routing.json`.
 *
 * Configures what model variant is used for tiered models (e.g. -tiered, -high, -medium, -low).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { agyDataFile } from './store/paths.ts'
import {
  DEFAULT_MODEL_ROUTING_TARGET,
  MODEL_ROUTING_VERSION,
  isValidModelRoutingTarget,
  type ModelRoutingDocument,
  type ModelRoutingSource,
  type ModelRoutingTarget,
  type ModelRoutingView,
} from './model-routing-types.ts'

export * from './model-routing-types.ts'

export const MODEL_ROUTING_FILE = 'agy-model-routing.json'
export const MODEL_ROUTING_ENV_VAR = 'DSH_AGY_MODEL_ROUTING'

export function sanitizeModelRouting(raw: unknown): ModelRoutingDocument {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { version: MODEL_ROUTING_VERSION }
  }
  const obj = raw as Record<string, unknown>
  const doc: ModelRoutingDocument = { version: MODEL_ROUTING_VERSION }
  if (isValidModelRoutingTarget(obj.target)) {
    doc.target = obj.target
  }
  return doc
}

export function parseModelRouting(text: string): ModelRoutingDocument {
  try {
    return sanitizeModelRouting(JSON.parse(text))
  } catch {
    return { version: MODEL_ROUTING_VERSION }
  }
}

export class ModelRoutingStore {
  readonly file: string
  private doc: ModelRoutingDocument
  private raw: string

  constructor(file: string = agyDataFile(MODEL_ROUTING_FILE)) {
    this.file = file
    const { doc, raw } = this.readWithRaw()
    this.doc = doc
    this.raw = raw
  }

  target(): ModelRoutingTarget {
    const envVal = process.env[MODEL_ROUTING_ENV_VAR]
    if (isValidModelRoutingTarget(envVal)) return envVal
    this.reloadIfChanged()
    return this.doc.target ?? DEFAULT_MODEL_ROUTING_TARGET
  }

  source(): ModelRoutingSource {
    const envVal = process.env[MODEL_ROUTING_ENV_VAR]
    if (isValidModelRoutingTarget(envVal)) return 'env'
    this.reloadIfChanged()
    return this.doc.target !== undefined ? 'stored' : 'default'
  }

  get(): ModelRoutingView {
    return {
      target: this.target(),
      source: this.source(),
    }
  }

  set(target: ModelRoutingTarget): ModelRoutingView {
    this.reload()
    const next: ModelRoutingDocument = {
      version: MODEL_ROUTING_VERSION,
      target,
    }
    this.write(next)
    this.doc = next
    this.raw = ModelRoutingStore.serialize(next)
    return this.get()
  }

  reload(): void {
    const fresh = this.readWithRaw()
    this.doc = fresh.doc
    this.raw = fresh.raw
  }

  private reloadIfChanged(): void {
    let current: string
    try {
      current = readFileSync(this.file, 'utf8')
    } catch {
      current = ''
    }
    if (current === this.raw) return
    this.reload()
  }

  private readWithRaw(): { doc: ModelRoutingDocument; raw: string } {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return { doc: { version: MODEL_ROUTING_VERSION }, raw: '' }
    }
    return { doc: parseModelRouting(text), raw: text }
  }

  private write(doc: ModelRoutingDocument): void {
    const serialized = ModelRoutingStore.serialize(doc)
    const tmp = `${this.file}.tmp.${process.pid}.${Date.now()}`
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(tmp, serialized, { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  static serialize(doc: ModelRoutingDocument): string {
    return `${JSON.stringify(doc, null, 2)}\n`
  }
}
