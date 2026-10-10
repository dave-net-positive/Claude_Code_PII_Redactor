import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

function stub(on: On) {
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
}

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'pii', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

test('list names types with on/off and the list counts', async ($, on) => {
  mock.store(on); stub(on)
  const r = await run($, 'list')
  expect(r.text).toMatch(/email\s+on/)
  expect(r.text).toMatch(/watchlist: 0/)
})

test('add validates and stores a custom type; rm removes it', async ($, on) => {
  mock.store(on); stub(on)
  const bad = await run($, 'add ref (a+)+')
  expect(bad.text).toMatch(/catastrophic/)
  const good = await run($, 'add ref REF-\\d{6}')
  expect(good.text).toMatch(/custom:ref/)
  expect((await run($, 'list')).text).toMatch(/custom:ref\s+on/)
  await run($, 'rm ref')
  expect((await run($, 'list')).text).not.toMatch(/custom:ref/)
})

test('on/off, watch/unwatch, allow/unallow, reads persist', async ($, on) => {
  mock.store(on); stub(on)
  await run($, 'off email')
  expect((await run($, 'list')).text).toMatch(/email\s+off/)
  await run($, 'on email')
  expect((await run($, 'list')).text).toMatch(/email\s+on/)
  await run($, 'watch Joanna Bloggs')
  expect((await run($, 'list')).text).toMatch(/watchlist: 1/)
  await run($, 'unwatch joanna bloggs')
  expect((await run($, 'list')).text).toMatch(/watchlist: 0/)
  const before = Number(/allowlist: (\d+)/.exec((await run($, 'list')).text ?? '')![1])
  await run($, 'allow Acme Corp')
  expect((await run($, 'list')).text).toMatch(new RegExp(`allowlist: ${before + 1}`))
  await run($, 'unallow Acme Corp')
  expect((await run($, 'list')).text).toMatch(new RegExp(`allowlist: ${before}\\b`))
  await run($, 'reads on')
  expect((await run($, 'list')).text).toMatch(/scan Read results: on/)
})

test('test reports matches for a saved type and for a raw regex, without saving', async ($, on) => {
  mock.store(on); stub(on)
  expect((await run($, 'test email mail a@b.co or c@d.co')).text).toMatch(/2 matches/)
  expect((await run($, 'test \\bREF-\\d{3}\\b see REF-123')).text).toMatch(/1 match\b/)
  expect((await run($, 'test (a+)+ aaa')).text).toMatch(/rejected/)
  expect((await run($, 'list')).text).not.toMatch(/custom:/)
})

test('bare /pii opens settings; unknown subcommand prints usage', async ($, on) => {
  mock.store(on); stub(on)
  expect((await run($, '')).text).toMatch(/settings opened/i)
  expect((await run($, 'bogus')).text).toMatch(/usage/i)
})
