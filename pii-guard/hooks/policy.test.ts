import { test, expect } from 'claude-code/testing'
import { defaultConfig } from './config'
import { parsePolicy, applyPolicy, emptyLocks, lockReason } from './policy'

const policy = {
  version: 1,
  watchlist: ['Acme Ltd', 'Project Nightjar'],
  allowlist: ['Acme Code'],
  types: { email: { enabled: true }, name: { enabled: false } },
  customTypes: [
    { id: 'acme-ref', label: 'Acme reference', regex: '\\bACME-\\d{6}\\b', placeholder: 'ACMEREF' },
    { id: 'bad', regex: '(a+)+' },
  ],
  scanToolReads: true,
}

test('parsePolicy accepts the documented shape and reports a bad regex', async () => {
  const { policy: p, errors } = parsePolicy(policy)
  expect(p.watchlist).toEqual(['Acme Ltd', 'Project Nightjar'])
  expect(p.allowlist).toEqual(['acme code'])
  expect(p.types).toEqual({ email: { enabled: true }, name: { enabled: false } })
  expect(p.customTypes.map(t => t.id)).toEqual(['custom:acme-ref'])
  expect(p.scanToolReads).toBe(true)
  expect(errors.length).toBe(1)
  expect(errors[0]).toMatch(/bad/)
})

test('parsePolicy tolerates garbage and unknown keys', async () => {
  expect(parsePolicy(undefined).policy.watchlist).toEqual([])
  expect(parsePolicy('nope').errors.length).toBe(1)
  const { policy: p, errors } = parsePolicy({ watchlist: 'x', types: [], future: 1 })
  expect(p.watchlist).toEqual([])
  expect(errors.length).toBe(0)
})

test('applyPolicy overlays the user config and reports what is locked', async () => {
  const user = { ...defaultConfig(), watchlist: ['Joanna'], allowlist: ['foo'] }
  user.types = user.types.map(t => t.id === 'email' ? { ...t, enabled: false } : t)
  const { policy: p } = parsePolicy(policy)
  const { config, locks } = applyPolicy(user, p)
  expect(config.watchlist).toEqual(['Joanna', 'Acme Ltd', 'Project Nightjar'])
  expect(config.allowlist).toContain('acme code')
  expect(config.allowlist).toContain('foo')
  expect(config.types.find(t => t.id === 'email')!.enabled).toBe(true)
  expect(config.types.find(t => t.id === 'name')!.enabled).toBe(false)
  expect(config.types.find(t => t.id === 'custom:acme-ref')!.placeholder).toBe('ACMEREF')
  expect(config.scanToolReads).toBe(true)
  expect(locks.watchlist).toEqual(['acme ltd', 'project nightjar'])
  expect(locks.allowlist).toEqual(['acme code'])
  expect(locks.types.sort()).toEqual(['custom:acme-ref', 'email', 'name'])
  expect(locks.scanToolReads).toBe(true)
  // the user's stored config is untouched
  expect(user.watchlist).toEqual(['Joanna'])
})

test('lockReason names what a policy holds and allows the rest', async () => {
  const { locks } = applyPolicy(defaultConfig(), parsePolicy(policy).policy)
  expect(lockReason(locks, { kind: 'type', id: 'email' })).toMatch(/policy/)
  expect(lockReason(locks, { kind: 'type', id: 'acme-ref' })).toMatch(/policy/)
  expect(lockReason(locks, { kind: 'type', id: 'card' })).toBe(null)
  expect(lockReason(locks, { kind: 'watchlist', term: 'ACME LTD' })).toMatch(/policy/)
  expect(lockReason(locks, { kind: 'watchlist', term: 'Joanna' })).toBe(null)
  expect(lockReason(locks, { kind: 'allowlist', term: 'acme code' })).toMatch(/policy/)
  expect(lockReason(locks, { kind: 'scanToolReads' })).toMatch(/policy/)
  expect(lockReason(emptyLocks(), { kind: 'scanToolReads' })).toBe(null)
})
