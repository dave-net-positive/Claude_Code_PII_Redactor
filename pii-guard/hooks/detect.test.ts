import { test, expect } from 'claude-code/testing'
import type { Config, Decision } from '../types'
import { BUILTIN_TYPES, DEFAULT_ALLOWLIST } from './patterns'
import { compilePattern, scan, redact, testPattern } from './detect'

const config = (over: Partial<Config> = {}): Config => ({
  version: 1,
  types: BUILTIN_TYPES.map(t => ({ ...t })),
  watchlist: [],
  allowlist: [...DEFAULT_ALLOWLIST],
  scanToolReads: false,
  ...over,
})

const ids = (f: { typeId: string }[]) => f.map(x => x.typeId)

test('finds email, card and NI number in one prompt', async () => {
  const text = 'Mail dave@example.com, card 4111 1111 1111 1111, NI AB 12 34 56 C.'
  const found = scan(text, 'prompt', config())
  expect(ids(found).sort()).toEqual(['card', 'email', 'ni-number'])
})

test('luhn failure is not a card', async () => {
  expect(scan('4111 1111 1111 1112', 'prompt', config())).toEqual([])
})

test('a card inside an IBAN reports once as IBAN', async () => {
  const found = scan('GB82 WEST 1234 5698 7654 32', 'prompt', config())
  expect(ids(found)).toEqual(['iban'])
})

test('watchlist hits report as name regardless of case', async () => {
  const found = scan('talk to joanna about it', 'prompt', config({ watchlist: ['Joanna'] }))
  expect(ids(found)).toEqual(['name'])
})

test('name heuristic keeps Dr Jane Smith and drops allowlisted pairs', async () => {
  const found = scan('Dr Jane Smith uses Claude Code in New York', 'prompt', config())
  expect(found.map(f => f.value)).toEqual(['Dr Jane Smith'])
})

test('allowlist suppresses any type', async () => {
  const c = config({ allowlist: ['dave@example.com'] })
  expect(scan('dave@example.com', 'prompt', c)).toEqual([])
})

test('disabled and session-allowed types are not scanned', async () => {
  const c = config()
  c.types.find(t => t.id === 'email')!.enabled = false
  expect(scan('a@b.co 4111 1111 1111 1111', 'prompt', c, { sessionAllows: ['card'] })).toEqual([])
})

test('secrets: anthropic key, aws key, generic assignment', async () => {
  const text = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123 AKIAABCDEFGHIJKLMNOP api_key = "zyxwvutsrqpo"'
  expect(scan(text, 'prompt', config()).length).toBe(3)
})

test('redact numbers placeholders per distinct value and threads numbering', async () => {
  const c = config()
  const text = 'a@b.co then c@d.co then a@b.co'
  const f = scan(text, 'prompt', c)
  const r1 = redact(text, f, { email: 'redact' }, {})
  expect(r1.text).toBe('[EMAIL_1] then [EMAIL_2] then [EMAIL_1]')
  expect(r1.count).toBe(3)
  const r2 = redact('c@d.co again', scan('c@d.co again', 'file:x', c), { email: 'redact' }, r1.numbering)
  expect(r2.text).toBe('[EMAIL_2] again')
})

test('allowed types are left in place', async () => {
  const c = config()
  const text = 'a@b.co 4111 1111 1111 1111'
  const decisions: Record<string, Decision> = { email: 'allow-once', card: 'redact' }
  expect(redact(text, scan(text, 'prompt', c), decisions, {}).text).toBe('a@b.co [CARD_1]')
})

test('compilePattern rejects nested quantifiers, empty matches and bad syntax', async () => {
  expect(compilePattern('(a+)+').ok).toBe(false)
  expect(compilePattern('(\\d*)*').ok).toBe(false)
  expect(compilePattern('a*').ok).toBe(false)
  expect(compilePattern('[').ok).toBe(false)
  expect(compilePattern('x'.repeat(501)).ok).toBe(false)
  expect(compilePattern('\\b\\d{3}-\\d{4}\\b').ok).toBe(true)
})

test('testPattern reports matches per sample', async () => {
  const r = testPattern('\\bREF-\\d{6}\\b', ['see REF-123456 and REF-1', 'none'])
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.matches).toEqual([
    { sample: 'see REF-123456 and REF-1', found: ['REF-123456'] },
    { sample: 'none', found: [] },
  ])
})

test('scan caps input at MAX_SCAN', async () => {
  const text = 'x'.repeat(200_000) + ' a@b.co'
  expect(scan(text, 'prompt', config())).toEqual([])
})
