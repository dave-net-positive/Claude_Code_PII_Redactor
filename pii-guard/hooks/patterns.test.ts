import { test, expect } from 'claude-code/testing'
import { VALIDATORS, BUILTIN_TYPES, DEFAULT_ALLOWLIST } from './patterns'

test('luhn accepts a valid card and rejects a bad check digit', async () => {
  expect(VALIDATORS.luhn('4111 1111 1111 1111')).toBe(true)
  expect(VALIDATORS.luhn('4111 1111 1111 1112')).toBe(false)
  expect(VALIDATORS.luhn('1234567890123')).toBe(false)
})

test('nhs mod-11 accepts a valid number and rejects a bad one', async () => {
  expect(VALIDATORS.nhs('943 476 5919')).toBe(true)
  expect(VALIDATORS.nhs('943 476 5918')).toBe(false)
})

test('iban mod-97 accepts a valid IBAN and rejects a transposed one', async () => {
  expect(VALIDATORS.iban('GB82 WEST 1234 5698 7654 32')).toBe(true)
  expect(VALIDATORS.iban('GB82 WEST 1234 5698 7654 23')).toBe(false)
})

test('none always passes', async () => {
  expect(VALIDATORS.none('anything')).toBe(true)
})

test('built-ins have unique ids, compile, and ship enabled', async () => {
  const ids = new Set(BUILTIN_TYPES.map(t => t.id))
  expect(ids.size).toBe(BUILTIN_TYPES.length)
  for (const t of BUILTIN_TYPES) {
    expect(t.enabled).toBe(true)
    expect(t.source).toBe('builtin')
    for (const p of t.patterns) expect(() => new RegExp(p, 'giu')).not.toThrow()
  }
  expect(DEFAULT_ALLOWLIST).toContain('claude code')
})
