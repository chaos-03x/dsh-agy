/**
 * Model display names must be unique in the picker.
 *
 * A subscription can advertise both `gemini-4-hydrogen` and
 * `gemini-4-hydrogen-tiered`, and both `-xhigh` forms; the tiered synthesis
 * strips `-tiered` when it formats a label, so two different ids rendered as the
 * same row — the picker showed "Gemini 4 Hydrogen" twice.
 */

import { describe, it, expect } from 'vitest'
import { mergeModelCatalog } from '../src/adapter/models.ts'

describe('mergeModelCatalog display names', () => {
  it('never renders two different ids under one label', () => {
    const merged = mergeModelCatalog({
      models: {
        'gemini-4-hydrogen': {},
        'gemini-4-hydrogen-tiered': {},
        'gemini-4-hydrogen-xhigh': {},
        'gemini-4-hydrogen-tiered-xhigh': {},
      },
    })
    const names = merged.map((model) => model.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('marks the tiered variant only when it would collide', () => {
    const colliding = mergeModelCatalog({
      models: { 'gemini-4-hydrogen': {}, 'gemini-4-hydrogen-tiered': {} },
    })
    const tiered = colliding.find((model) => model.id === 'gemini-4-hydrogen-tiered')
    expect(tiered?.name).toMatch(/Tiered/i)

    // Alone, the tiered id IS the base label: that is how it hides the split
    // low/medium/high siblings, so a suffix here would break the unification.
    const alone = mergeModelCatalog({ models: { 'gemini-4-hydrogen-tiered': {} } })
    expect(alone[0]?.name).toBe('Gemini 4 Hydrogen')
  })
})
