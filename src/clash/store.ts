/**
 * Persisted Clash state (`$DSH_HOME/agy/agy-clash.json`).
 *
 * Two fields are credentials: the subscription URL carries a provider token in
 * its path, and the controller secret authenticates the loopback REST API. The
 * file is therefore 0600 (tmp + rename, the same pattern as the account store),
 * and nothing that reads it may echo either value into a log or an RPC reply.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { agyDataFile } from '../store/paths.ts'
import { emptyClashState, type ClashState } from './types.ts'

export const CLASH_STATE_VERSION = 1

function sanitize(raw: unknown): ClashState {
  const base = emptyClashState()
  if (raw === null || typeof raw !== 'object') return base
  const record = raw as Record<string, unknown>
  const str = (key: keyof ClashState): string => (typeof record[key] === 'string' ? record[key] as string : String(base[key]))
  const num = (key: keyof ClashState): number => {
    const value = record[key]
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65_536 ? value : base[key] as number
  }
  const bool = (key: keyof ClashState): boolean => (typeof record[key] === 'boolean' ? record[key] as boolean : base[key] as boolean)
  return {
    enabled: bool('enabled'),
    subscriptionUrl: str('subscriptionUrl'),
    mixedPort: num('mixedPort'),
    controllerPort: num('controllerPort'),
    controllerSecret: str('controllerSecret'),
    group: str('group'),
    autoRotate: bool('autoRotate'),
    node: str('node'),
    fetchedAt: str('fetchedAt'),
    lastError: str('lastError'),
  }
}

/** Default state path; `$DSH_HOME` relocates it with everything else. */
export function defaultClashStateFile(): string {
  return agyDataFile('agy-clash.json')
}

export class ClashStore {
  private readonly file: string

  constructor(file: string = defaultClashStateFile()) {
    this.file = file
  }

  get path(): string {
    return this.file
  }

  /** Never throws: an unreadable or corrupt file degrades to the empty state. */
  load(): ClashState {
    try {
      return sanitize(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      return emptyClashState()
    }
  }

  save(state: ClashState): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: CLASH_STATE_VERSION, ...state }, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}
