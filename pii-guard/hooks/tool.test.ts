import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import * as toolModule from './tool'
import * as configModule from './config'
import { emptyLocks } from './policy'

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

test('add stores a custom type and list shows it; remove is refused', async ($, on) => {
  mock.store(on); stub(on)
  const bad = await call($, { action: 'add', id: 'ref', regex: '(a+)+' })
  expect(bad.ok).toBe(false)
  const good = await call($, { action: 'add', id: 'ref', label: 'Internal ref', regex: '\\bREF-\\d{6}\\b', placeholder: 'REF' })
  expect(good.ok).toBe(true)
  const list = await call($, { action: 'list' })
  expect(JSON.stringify(list.data)).toMatch(/custom:ref/)
  const rm = await call($, { action: 'remove', id: 'ref' })
  expect(rm.ok).toBe(false)
  expect(JSON.stringify((await call($, { action: 'list' })).data)).toMatch(/custom:ref/)
})

test('watch and enable persist', async ($, on) => {
  mock.store(on, { config: { version: 1, types: [{ id: 'email', source: 'builtin', enabled: false }], watchlist: [], allowlist: [], scanToolReads: false } }); stub(on)
  expect((await call($, { action: 'watch', term: 'Joanna' })).ok).toBe(true)
  expect((await call($, { action: 'toggle', id: 'email', enabled: true })).ok).toBe(true)
  const data = (await call($, { action: 'list' })).data as { watchlistCount: number; types: { id: string; enabled: boolean }[] }
  expect(data.watchlistCount).toBe(1)
  expect(data.types.find(t => t.id === 'email')!.enabled).toBe(true)
})

test('unknown action and missing fields are refused', async ($, on) => {
  mock.store(on); stub(on)
  expect((await call($, { action: 'explode' })).ok).toBe(false)
  expect((await call($, { action: 'add' })).ok).toBe(false)
  expect((await call($, { action: 'test', regex: 'x' })).ok).toBe(false)
})

test('weakening actions are refused by the tool and pointed at /pii', async ($, on) => {
  mock.store(on); stub(on)
  for (const input of [
    { action: 'remove', id: 'email' },
    { action: 'toggle', id: 'email', enabled: false },
    { action: 'allow', term: 'x' },
    { action: 'unwatch', term: 'x' },
    { action: 'unallow', term: 'x' },
  ]) {
    const r = await call($, input)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/\/pii/)
  }
  const data = (await call($, { action: 'list' })).data as { types: { id: string; enabled: boolean }[] }
  expect(data.types.find(t => t.id === 'email')!.enabled).toBe(true)
})

test('list reports watchlist and allowlist counts, never the entries', async ($, on) => {
  mock.store(on, { config: { version: 1, types: [], watchlist: ['Joanna Bloggs'], allowlist: ['acme'], scanToolReads: false } }); stub(on)
  const r = await call($, { action: 'list' })
  expect(JSON.stringify(r)).not.toMatch(/Joanna/)
  expect(r.data).toMatchObject({ watchlistCount: 1, allowlistCount: 1 })
})

test('subagent calls are refused', async ($, on) => {
  mock.store(on); stub(on)
  const r = await $.tool.call({ tool: TOOL, action: 'list', agentId: 'sub-1' } as never)
  expect('result' in r && (r.result as Answer).ok).toBe(false)
})

test('the tool cannot add a custom type whose id a policy holds', async ($, on) => {
  mock.store(on); stub(on)
  const { runPatternsTool } = toolModule
  const user = configModule.defaultConfig()
  const locks = { ...emptyLocks(), types: ['custom:acme-ref'] }
  const r = runPatternsTool(user, { action: 'add', id: 'acme-ref', regex: 'x+' }, locks)
  expect(r.answer.ok).toBe(false)
  expect(r.answer.message).toMatch(/policy/)
})
