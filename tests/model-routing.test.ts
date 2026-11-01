import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL_ROUTING_TARGET,
  isValidModelRoutingTarget,
  MODEL_ROUTING_ENV_VAR,
  MODEL_ROUTING_TARGETS,
  ModelRoutingStore,
  parseModelRouting,
  routeModel,
  sanitizeModelRouting,
} from '../src/model-routing.ts'

describe('model routing vocabulary and routing function', () => {
  it('validates supported model routing targets', () => {
    for (const target of MODEL_ROUTING_TARGETS) {
      expect(isValidModelRoutingTarget(target)).toBe(true)
    }
    expect(isValidModelRoutingTarget('invalid')).toBe(false)
    expect(isValidModelRoutingTarget(null)).toBe(false)
    expect(isValidModelRoutingTarget(undefined)).toBe(false)
    expect(isValidModelRoutingTarget(123)).toBe(false)
  })

  it('routes tiered models according to target setting', () => {
    expect(routeModel('gemini-3.8-flash-tiered', 'high')).toBe('gemini-3.8-flash-high')
    expect(routeModel('gemini-3.8-flash-tiered', 'medium')).toBe('gemini-3.8-flash-medium')
    expect(routeModel('gemini-3.8-flash-tiered', 'low')).toBe('gemini-3.8-flash-low')
    expect(routeModel('gemini-3.8-flash-tiered', 'tiered')).toBe('gemini-3.8-flash-tiered')

    // Non-tiered models (and explicit tier requests) pass through verbatim
    expect(routeModel('gemini-3.8-flash-low', 'high')).toBe('gemini-3.8-flash-low')
    expect(routeModel('claude-sonnet-4.5', 'high')).toBe('claude-sonnet-4.5')
    expect(routeModel('gemini-3.1-flash-lite', 'high')).toBe('gemini-3.1-flash-lite')
    expect(routeModel('', 'high')).toBe('')
  })

  it('selects the configured model variant in discovery instead of hardcoding -tiered', async () => {
    const { chatCallableDiscoveredIds } = await import('../src/adapter/models.ts')
    const dynamic = {
      models: {
        'gemini-3.8-flash-tiered': {},
        'gemini-3.8-flash-high': {},
        'gemini-3.8-flash-medium': {},
        'gemini-3.8-flash-low': {},
        'claude-sonnet-4.5': {},
      },
    }
    // Default 'tiered' hides low/medium/high, exposes -tiered
    expect(chatCallableDiscoveredIds(dynamic, 'tiered')).toEqual(['gemini-3.8-flash-tiered', 'claude-sonnet-4.5'])
    // 'high' hides tiered/low/medium, exposes -high
    expect(chatCallableDiscoveredIds(dynamic, 'high')).toEqual(['gemini-3.8-flash-high', 'claude-sonnet-4.5'])
    // 'medium' hides tiered/low/high, exposes -medium
    expect(chatCallableDiscoveredIds(dynamic, 'medium')).toEqual(['gemini-3.8-flash-medium', 'claude-sonnet-4.5'])
    // 'low' hides tiered/medium/high, exposes -low
    expect(chatCallableDiscoveredIds(dynamic, 'low')).toEqual(['gemini-3.8-flash-low', 'claude-sonnet-4.5'])
  })
})

describe('ModelRoutingStore', () => {
  const tmpFiles: string[] = []
  afterEach(() => {
    delete process.env[MODEL_ROUTING_ENV_VAR]
    for (const f of tmpFiles) {
      if (existsSync(f)) rmSync(f)
    }
    tmpFiles.length = 0
  })

  const makeTempFile = () => {
    const f = join(tmpdir(), `agy-routing-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    tmpFiles.push(f)
    return f
  }

  it('parses and sanitizes model routing document', () => {
    expect(sanitizeModelRouting(null)).toEqual({ version: 1 })
    expect(sanitizeModelRouting({ target: 'high' })).toEqual({ version: 1, target: 'high' })
    expect(sanitizeModelRouting({ target: 'bad' })).toEqual({ version: 1 })
    expect(parseModelRouting('invalid json')).toEqual({ version: 1 })
  })

  it('defaults to tiered when file does not exist', () => {
    const store = new ModelRoutingStore(makeTempFile())
    expect(store.target()).toBe(DEFAULT_MODEL_ROUTING_TARGET)
    expect(store.source()).toBe('default')
    expect(store.get()).toEqual({ target: 'tiered', source: 'default' })
  })

  it('persists and reloads routing choice', () => {
    const file = makeTempFile()
    const store = new ModelRoutingStore(file)
    store.set('high')
    expect(store.target()).toBe('high')
    expect(store.source()).toBe('stored')

    const reloaded = new ModelRoutingStore(file)
    expect(reloaded.target()).toBe('high')
    expect(reloaded.source()).toBe('stored')
  })

  it('respects environment variable override', () => {
    const file = makeTempFile()
    const store = new ModelRoutingStore(file)
    store.set('low')
    expect(store.target()).toBe('low')

    process.env[MODEL_ROUTING_ENV_VAR] = 'high'
    expect(store.target()).toBe('high')
    expect(store.source()).toBe('env')
  })
})
