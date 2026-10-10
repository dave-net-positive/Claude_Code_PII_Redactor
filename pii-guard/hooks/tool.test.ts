import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__pii-guard__pii_patterns'

function stub(on: On) {
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('command.register', () => ({ value: { command: 'pii' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
}

type Answer = { ok: boolean; message: string; data?: unknown }

async function call($: Engine, input: Record<string, unknown>): Promise<Answer> {
  const r = await $.tool.call({ tool: TOOL, ...input } as never)
  if (!('result' in r) || r.result === undefined) throw new Error(`no result: ${JSON.stringify(r)}`)
  return r.result as Answer
}

test('session.start registers the tool and the command', async ($, on) => {
  mock.store(on)
  const registered: string[] = []
  on('tool.register', ($, e) => { registered.push(e.name); return { value: { tool: TOOL } } })
  on('command.register', ($, e) => { registered.push(e.name); return { value: { command: e.name } } })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: 'E:/x', surface: 'terminal', isInteractive: true })
  expect(registered.sort()).toEqual(['pii', 'pii_patterns'])
})

test('test action works on an unsaved regex and reports per sample', async ($, on) => {
  mock.store(on); stub(on)
  const r = await call($, { action: 'test', regex: '\\bREF-\\d{6}\\b', samples: ['REF-123456', 'REF-12'] })
  expect(r.ok).toBe(true)
  expect(r.data).toEqual([{ sample: 'REF-123456', found: ['REF-123456'] }, { sample: 'REF-12', found: [] }])
})

test('add stores a custom type; list shows it; remove deletes it', async ($, on) => {
  mock.store(on); stub(on)
  const bad = await call($, { action: 'add', id: 'ref', regex: '(a+)+' })
  expect(bad.ok).toBe(false)
  const good = await call($, { action: 'add', id: 'ref', label: 'Internal ref', regex: '\\bREF-\\d{6}\\b', placeholder: 'REF' })
  expect(good.ok).toBe(true)
  const list = await call($, { action: 'list' })
  expect(JSON.stringify(list.data)).toMatch(/custom:ref/)
  const rm = await call($, { action: 'remove', id: 'ref' })
  expect(rm.ok).toBe(true)
  expect(JSON.stringify((await call($, { action: 'list' })).data)).not.toMatch(/custom:ref/)
})

test('watch, allow, toggle persist', async ($, on) => {
  mock.store(on); stub(on)
  expect((await call($, { action: 'watch', term: 'Joanna' })).ok).toBe(true)
  expect((await call($, { action: 'allow', term: 'Acme' })).ok).toBe(true)
  expect((await call($, { action: 'toggle', id: 'email', enabled: false })).ok).toBe(true)
  const data = (await call($, { action: 'list' })).data as { watchlist: string[]; allowlist: string[]; types: { id: string; enabled: boolean }[] }
  expect(data.watchlist).toEqual(['Joanna'])
  expect(data.allowlist).toContain('acme')
  expect(data.types.find(t => t.id === 'email')!.enabled).toBe(false)
})

test('unknown action and missing fields are refused', async ($, on) => {
  mock.store(on); stub(on)
  expect((await call($, { action: 'explode' })).ok).toBe(false)
  expect((await call($, { action: 'add' })).ok).toBe(false)
  expect((await call($, { action: 'test', regex: 'x' })).ok).toBe(false)
})
