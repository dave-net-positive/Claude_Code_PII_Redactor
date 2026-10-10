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

/** Bottom hooks for what the gate calls on `$`; `opened` resolves once the pane was asked for, `nextOpen()` re-arms it. */
function stub(on: On, over: { open?: () => never } = {}) {
  const log: string[] = []
  let signal!: () => void
  const arm = () => new Promise<void>(r => { signal = r })
  const opened = arm()
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
  return { log, opened, nextOpen: arm }
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

test('mentioned file is scanned, shown, and redacted at attachment time', async ($, on) => {
  mock.store(on)
  let signal!: () => void
  const opened = new Promise<void>(r => { signal = r })
  on('ui.open', () => { signal(); return { value: { isPlaced: true as const } } })
  on('ui.close', () => ({ value: undefined })); on('ui.toast', () => ({ value: undefined })); on('ui.log', () => ({ value: undefined }))
  on('fs.stat', ($, e) => {
    if (e.path.endsWith('notes.md')) return { value: { kind: 'file' as const, size: 10, mtimeMs: 0, isLink: false } }
    throw new Error('ENOENT')
  })
  on('fs.read', ($, e) => {
    if (e.path.endsWith('notes.md')) return { value: 'contact joanna@example.com now' }
    throw new Error('ENOENT')
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))

  const run = $.prompt.submit(submit('summarise @notes.md please'))
  await opened
  const ui = await $.ui.mount({ plugin: 'pii-guard', surface: 'terminal', component: 'Pane', requestId: 'pii-guard', props: paneProps })
  expect(await ui.find({ text: /@notes\.md/ })).toBeTruthy()
  expect(await ui.find({ text: /1 finding in 2 sections/ })).toBeTruthy()
  await ui.press({ key: 'send' })
  expect(await run).toEqual({ text: 'summarise @notes.md please' })

  const framed = 'Called the Read tool with the following input: {"file_path":"notes.md"}\n\nResult of calling the Read tool:\ncontact joanna@example.com now'
  const att = await $.prompt.attachment({ type: 'file', text: framed, origin: { kind: 'engine' } } as never)
  expect(att).toEqual({ text: framed.replace('joanna@example.com', '[EMAIL_1]') })

  const again = await $.prompt.attachment({ type: 'file', text: framed, origin: { kind: 'engine' } } as never)
  expect(again).toEqual({ text: framed })
})

test('a cancelled review leaves no pending file redactions', async ($, on) => {
  mock.store(on)
  let signal!: () => void
  const opened = new Promise<void>(r => { signal = r })
  on('ui.open', () => { signal(); return { value: { isPlaced: true as const } } })
  on('ui.close', () => ({ value: undefined })); on('ui.toast', () => ({ value: undefined })); on('ui.log', () => ({ value: undefined }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 10, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: 'a@b.co' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  const run = $.prompt.submit(submit('see @x.txt'))
  await opened
  const ui = await $.ui.mount({ plugin: 'pii-guard', surface: 'terminal', component: 'Pane', requestId: 'pii-guard', props: paneProps })
  await ui.press({ key: 'cancel' })
  expect(await run).toEqual({ drop: 'Cancelled in PII review' })
  const att = await $.prompt.attachment({ type: 'file', text: 'x.txt\na@b.co', origin: { kind: 'engine' } } as never)
  expect(att).toEqual({ text: 'x.txt\na@b.co' })
})

test('skips unreadable mentions and directories', async ($, on) => {
  mock.store(on); stub(on)
  const r = await $.prompt.submit(submit('look at @missing.txt and @src/'))
  expect(r).toEqual({ text: 'look at @missing.txt and @src/' })
})

test('allow this session: a later prompt with only that type passes silently', async ($, on) => {
  mock.store(on); const { log, opened } = stub(on)
  const run = $.prompt.submit(submit('a@b.co'))
  await opened
  const ui = await $.ui.mount({ plugin: 'pii-guard', surface: 'terminal', component: 'Pane', requestId: 'pii-guard', props: paneProps })
  await ui.press({ key: 'decide:email:allow-session' })
  await ui.press({ key: 'send' })
  expect(await run).toEqual({ text: 'a@b.co' })
  const toastsBefore = log.filter(l => l.startsWith('toast:')).length
  const second = await $.prompt.submit(submit('again c@d.co'))
  expect(second).toEqual({ text: 'again c@d.co' })
  expect(log.filter(l => l.startsWith('toast:')).length).toBe(toastsBefore)
})

test('session-allowed type is listed in settings and revoke re-arms it', async ($, on) => {
  mock.store(on); const { opened, nextOpen } = stub(on)
  const run = $.prompt.submit(submit('a@b.co'))
  await opened
  const ui = await $.ui.mount({ plugin: 'pii-guard', surface: 'terminal', component: 'Pane', requestId: 'pii-guard', props: paneProps })
  await ui.press({ key: 'decide:email:allow-session' })
  await ui.press({ key: 'send' })
  await run
  // No review pending now, so the same mounted pane redraws as settings.
  expect(await ui.find({ key: 'revoke:email' })).toBeTruthy()
  await ui.press({ key: 'revoke:email' })
  expect(await ui.find({ key: 'revoke:email' })).toBeFalsy()
  const reopened = nextOpen()
  const run2 = $.prompt.submit(submit('c@d.co'))
  await reopened
  expect(await ui.find({ key: 'cancel' })).toBeTruthy()
  await ui.press({ key: 'cancel' })
  expect(await run2).toEqual({ drop: 'Cancelled in PII review' })
})
