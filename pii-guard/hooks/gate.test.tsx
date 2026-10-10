import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

const paneProps = {
  title: 'PII review',
  isFocused: true,
  bodyColumns: 100,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

/** Bottom hooks for what the gate calls on `$`; `opened` resolves once the pane was asked for. */
function stub(on: On, over: { open?: () => never } = {}) {
  const log: string[] = []
  let signal!: () => void
  const opened = new Promise<void>(r => { signal = r })
  on('ui.open', () => {
    if (over.open) over.open()
    signal()
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', ($, e) => { log.push(`toast:${e.text}`); return { value: undefined } })
  on('ui.log', ($, e) => { log.push(`log:${e.text}`); return { value: undefined } })
  on('fs.stat', () => { throw new Error('ENOENT') })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  return { log, opened }
}

const submit = (text: string, extra: Record<string, unknown> = {}) =>
  ({ text, wait: false, origin: { kind: 'composer' as const }, ...extra })

for (const surface of ['terminal', 'desktop'] as const) {
  test(`clean prompt passes untouched on ${surface}`, async ($, on) => {
    mock.store(on); stub(on)
    const r = await $.prompt.submit(submit('hello world'))
    expect(r).toEqual({ text: 'hello world' })
  })

  test(`review draws sections, rows and footer; redact card, allow email, send on ${surface}`, async ($, on) => {
    mock.store(on); const { opened } = stub(on)
    const run = $.prompt.submit(submit('mail a@b.co card 4111 1111 1111 1111'))
    await opened
    const ui = await $.ui.mount({ plugin: 'pii-guard', surface, component: 'Pane', requestId: 'pii-guard', props: paneProps })
    expect(await ui.find({ text: /2 findings in 1 section/ })).toBeTruthy()
    expect(await ui.find({ key: 'decide:card:allow-session' })).toBeTruthy()
    expect((await ui.find({ key: 'send' }))?.props.label).toBe('Send with 2 redactions')
    const highlighted = await ui.findAll({ type: 'Text', text: 'a@b.co' })
    expect(highlighted.some(t => t.props.inverse === true)).toBe(true)
    await ui.press({ key: 'decide:email:allow-once' })
    expect((await ui.find({ key: 'send' }))?.props.label).toBe('Send with 1 redaction')
    await ui.press({ key: 'send' })
    expect(await run).toEqual({ text: 'mail a@b.co card [CARD_1]' })
  })

  test(`cancel drops the prompt on ${surface}`, async ($, on) => {
    mock.store(on); const { log, opened } = stub(on)
    const run = $.prompt.submit(submit('a@b.co'))
    await opened
    const ui = await $.ui.mount({ plugin: 'pii-guard', surface, component: 'Pane', requestId: 'pii-guard', props: paneProps })
    await ui.press({ key: 'cancel' })
    expect(await run).toEqual({ drop: 'Cancelled in PII review' })
    expect(log.some(l => l.startsWith('toast:Prompt cancelled'))).toBe(true)
  })
}

test('image attachment with no text findings asks; send passes unchanged', async ($, on) => {
  mock.store(on); const { opened } = stub(on)
  const run = $.prompt.submit(submit('look at this', { attachments: [{ type: 'image', mediaType: 'image/png', filename: 'x.png' }] }))
  await opened
  const ui = await $.ui.mount({ plugin: 'pii-guard', surface: 'terminal', component: 'Pane', requestId: 'pii-guard', props: paneProps })
  expect(await ui.find({ text: /x\.png/ })).toBeTruthy()
  await ui.press({ key: 'send' })
  expect(await run).toEqual({ text: 'look at this' })
})

test('plugin-origin prompts are not scanned', async ($, on) => {
  mock.store(on); stub(on)
  const r = await $.prompt.submit(submit('a@b.co', { origin: { kind: 'plugin', name: 'other' } }))
  expect(r).toEqual({ text: 'a@b.co' })
})

test('ignores slash-command prompts', async ($, on) => {
  mock.store(on); stub(on)
  const r = await $.prompt.submit(submit('/pii allow a@b.co'))
  expect(r).toEqual({ text: '/pii allow a@b.co' })
})

test('sdk origin redacts everything and continues, logging counts only', async ($, on) => {
  mock.store(on); const { log } = stub(on)
  const r = await $.prompt.submit(submit('a@b.co', { origin: { kind: 'sdk' } }))
  expect(r).toEqual({ text: '[EMAIL_1]' })
  expect(log.some(l => l.startsWith('log:pii-guard: headless') && !l.includes('a@b.co'))).toBe(true)
})

test('a failure while opening the pane fails closed', async ($, on) => {
  mock.store(on); stub(on, { open: () => { throw new Error('surface exploded') } })
  const r = await $.prompt.submit(submit('a@b.co'))
  expect('drop' in r && typeof r.drop === 'string').toBe(true)
})
