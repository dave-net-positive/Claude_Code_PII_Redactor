import { test, expect } from 'claude-code/testing'
import { BUILTIN_TYPES } from './patterns'
import { defaultConfig, mergeBuiltins, addCustomType, removeType, setEnabled, addTerm, removeTerm } from './config'

test('defaultConfig has every built-in enabled and the default allowlist', async () => {
  const c = defaultConfig()
  expect(c.types.length).toBe(BUILTIN_TYPES.length)
  expect(c.scanToolReads).toBe(false)
  expect(c.allowlist).toContain('claude code')
})

test('mergeBuiltins keeps stored toggles and custom types, adds new built-ins', async () => {
  const stored = {
    version: 1,
    types: [
      { id: 'email', label: 'Email address', category: 'contact', enabled: false, source: 'builtin', patterns: ['stale'], validator: 'none', placeholder: 'EMAIL' },
      { id: 'custom:ref', label: 'Ref', category: 'custom', enabled: true, source: 'custom', patterns: ['REF-\\d+'], validator: 'none', placeholder: 'REF' },
      { id: 'retired', label: 'Old', category: 'identity', enabled: true, source: 'builtin', patterns: ['x'], validator: 'none', placeholder: 'OLD' },
    ],
    watchlist: ['Joanna'], allowlist: ['foo'], scanToolReads: true,
  }
  const c = mergeBuiltins(stored)
  const email = c.types.find(t => t.id === 'email')!
  expect(email.enabled).toBe(false)
  expect(email.patterns).toEqual(BUILTIN_TYPES.find(t => t.id === 'email')!.patterns)
  expect(c.types.some(t => t.id === 'custom:ref')).toBe(true)
  expect(c.types.some(t => t.id === 'retired')).toBe(false)
  expect(c.types.some(t => t.id === 'card')).toBe(true)
  expect(c.watchlist).toEqual(['Joanna'])
  expect(c.scanToolReads).toBe(true)
})

test('mergeBuiltins tolerates garbage', async () => {
  expect(mergeBuiltins(undefined).types.length).toBe(BUILTIN_TYPES.length)
  expect(mergeBuiltins({ types: 'nope' }).types.length).toBe(BUILTIN_TYPES.length)
})

test('addCustomType validates and prefixes the id', async () => {
  const c = defaultConfig()
  const bad = addCustomType(c, { id: 'ref', regex: '(a+)+' })
  expect(bad.ok).toBe(false)
  const good = addCustomType(c, { id: 'ref', regex: 'REF-\\d{6}' })
  expect(good.ok).toBe(true)
  if (good.ok) {
    const t = good.config.types.find(t => t.id === 'custom:ref')!
    expect(t.placeholder).toBe('REF')
    expect(t.source).toBe('custom')
    expect(t.enabled).toBe(true)
  }
  const dup = good.ok ? addCustomType(good.config, { id: 'ref', regex: 'x+' }) : bad
  expect(dup.ok).toBe(false)
})

test('removeType refuses built-ins, setEnabled refuses unknown ids', async () => {
  const c = defaultConfig()
  expect(removeType(c, 'email').ok).toBe(false)
  expect(setEnabled(c, 'nope', true).ok).toBe(false)
  const off = setEnabled(c, 'email', false)
  expect(off.ok && off.config.types.find(t => t.id === 'email')!.enabled).toBe(false)
})

test('addTerm dedupes case-insensitively, removeTerm removes', async () => {
  let c = addTerm(defaultConfig(), 'allowlist', 'Foo')
  c = addTerm(c, 'allowlist', 'foo')
  expect(c.allowlist.filter(t => t === 'foo').length).toBe(1)
  c = removeTerm(c, 'allowlist', 'FOO')
  expect(c.allowlist.includes('foo')).toBe(false)
})
