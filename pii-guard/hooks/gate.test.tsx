import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const paneProps = {
  title: 'PII review',
  isFocused: true,
  bodyColumns: 100,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

type Submitted = { text: string; origin: unknown; context?: readonly string[] }

/**
 * Bottom hooks for what the gate calls on `$`. `submitted` records every prompt
 * that reached the bottom (the plugin's resubmits included); `asked` answers
 * the engine's AskUserQuestion dialog with the label `answer()` returns.
 */
type FsStub = { stat?: (path: string) => { kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }; read?: (path: string) => string }
function stub(on: On, over: { open?: () => never; answer?: (options: string[]) => string; fs?: FsStub } = {}) {
  const log: string[] = []
  const submitted: Submitted[] = []
  let opens = 0
  on('ui.open', () => {
    if (over.open) over.open()
    opens++
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', ($, e) => { log.push(`toast:${e.text}`); return { value: undefined } })
  on('ui.log', ($, e) => { log.push(`log:${e.text}`); return { value: undefined } })
  on('fs.stat', ($, e) => { if (over.fs?.stat) return { value: over.fs.stat(e.path) }; throw new Error('ENOENT') })
  on('fs.read', ($, e) => { if (over.fs?.read) return { value: over.fs.read(e.path) }; throw new Error('ENOENT') })
  on('command.list', () => ({ value: [{ name: 'pii', description: '', source: 'plugin' as never }] }))
  on('prompt.submit', ($, e) => { submitted.push({ text: e.text, origin: e.origin, context: e.context }); return { text: e.text } })
  on('prompt.compose', () => ({ sections: [{ id: 'core', text: 'base', scope: 'shared' as const }] }))
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const q = (e as unknown as { questions: { question: string; options: { label: string }[] }[] }).questions[0]!
    const label = over.answer ? over.answer(q.options.map(o => o.label)) : q.options[0]!.label
    return { result: { questions: [q], answers: { [q.question]: label } } } as never
  })
  return { log, submitted, opens: () => opens }
}

const submit = (text: string, extra: Record<string, unknown> = {}) =>
  ({ text, wait: false, origin: { kind: 'composer' as const }, ...extra })

const mount = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'pii-guard', surface, component: 'Pane', requestId: 'pii-guard', props: paneProps })

const HELD = { drop: 'Held for PII review' }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`clean prompt passes untouched on ${surface}`, async ($, on) => {
    mock.store(on); stub(on)
    expect(await $.prompt.submit(submit('hello world'))).toEqual({ text: 'hello world' })
  })

  test(`review holds the prompt; redact card, allow email, send resubmits as the user on ${surface}`, async ($, on) => {
    mock.store(on); const { submitted } = stub(on)
    expect(await $.prompt.submit(submit('mail a@b.co card 4111 1111 1111 1111'))).toEqual(HELD)
    const ui = await mount($, surface)
    expect(await ui.find({ text: /2 findings in 1 section/ })).toBeTruthy()
    expect(await ui.find({ key: 'decide:card:allow-session' })).toBeTruthy()
    expect((await ui.find({ key: 'send' }))?.props.label).toBe('Send with 2 redactions')
    const highlighted = await ui.findAll({ type: 'Text', text: 'a@b.co' })
    expect(highlighted.some(t => t.props.inverse === true)).toBe(true)
    await ui.press({ key: 'decide:email:allow-once' })
    expect((await ui.find({ key: 'send' }))?.props.label).toBe('Send with 1 redaction')
    await ui.press({ key: 'send' })
    expect(submitted.length).toBe(1)
    expect(submitted[0]!.text).toBe('mail a@b.co card [CARD_1]')
    expect(submitted[0]!.origin).toMatchObject({ kind: 'plugin', name: 'pii-guard', asUser: true })
    // After a redaction the system prompt carries the placeholder note.
    const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    expect(composed.sections.some(s => s.id === 'pii-guard:placeholders' && /placeholder/i.test(s.text))).toBe(true)
    // The pane falls back to settings once nothing is pending.
    expect(await ui.find({ key: 'back' })).toBeTruthy()
  })

  test(`cancel discards the held prompt on ${surface}`, async ($, on) => {
    mock.store(on); const { log, submitted } = stub(on)
    expect(await $.prompt.submit(submit('a@b.co'))).toEqual(HELD)
    const ui = await mount($, surface)
    await ui.press({ key: 'cancel' })
    expect(submitted).toEqual([])
    expect(log.some(l => l.startsWith('toast:Prompt cancelled'))).toBe(true)
  })
}

test('a second prompt during a review is queued and shown after the first is sent', async ($, on) => {
  mock.store(on); const { submitted } = stub(on)
  expect(await $.prompt.submit(submit('first a@b.co'))).toEqual(HELD)
  expect(await $.prompt.submit(submit('second 4111 1111 1111 1111'))).toEqual(HELD)
  const ui = await mount($)
  expect(await ui.find({ text: /first/ })).toBeTruthy()
  expect(await ui.find({ text: /1 more prompt waiting/ })).toBeTruthy()
  await ui.press({ key: 'send' })
  expect(submitted.map(s => s.text)).toEqual(['first [EMAIL_1]'])
  expect(await ui.find({ text: /second/ })).toBeTruthy()
  await ui.press({ key: 'send' })
  expect(submitted.map(s => s.text)).toEqual(['first [EMAIL_1]', 'second [CARD_1]'])
})

test('text findings plus an image: the engine dialog decides, attachments are kept', async ($, on) => {
  mock.store(on); const { opens } = stub(on, { answer: o => o.find(x => x.startsWith('Redact'))! })
  const r = await $.prompt.submit(submit('mail a@b.co', { attachments: [{ type: 'image', mediaType: 'image/png', filename: 'x.png' }] }))
  expect(r).toEqual({ text: 'mail [EMAIL_1]' })
  expect(opens()).toBe(1)
})

test('image only: the dialog offers Send or Cancel', async ($, on) => {
  mock.store(on); stub(on, { answer: () => 'Cancel' })
  const r = await $.prompt.submit(submit('look', { attachments: [{ type: 'image', mediaType: 'image/png', filename: 'x.png' }] }))
  expect(r).toEqual({ drop: 'Cancelled in PII review' })
})

test('plugin-origin prompts are not scanned', async ($, on) => {
  mock.store(on); stub(on)
  const r = await $.prompt.submit(submit('a@b.co', { origin: { kind: 'plugin', name: 'other' } }))
  expect(r).toEqual({ text: 'a@b.co' })
})

test('only a registered slash command skips the scan', async ($, on) => {
  mock.store(on); stub(on)
  expect(await $.prompt.submit(submit('/pii allow a@b.co'))).toEqual({ text: '/pii allow a@b.co' })
  expect(await $.prompt.submit(submit('/var/log/app.log shows john@x.com failing'))).toEqual(HELD)
})

test('a non-interactive session redacts everything inline, logging counts only', async ($, on) => {
  mock.store(on); const { log } = stub(on)
  on('tool.register', () => ({ value: { tool: 'x' } })); on('command.register', () => ({ value: { command: 'pii' } })); on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: 'E:/x', surface: null, isInteractive: false })
  const r = await $.prompt.submit(submit('a@b.co'))
  expect(r).toEqual({ text: '[EMAIL_1]' })
  expect(log.some(l => l.startsWith('log:pii-guard: non-interactive') && !l.includes('a@b.co'))).toBe(true)
})

test('a failure while opening the pane fails closed', async ($, on) => {
  mock.store(on); stub(on, { open: () => { throw new Error('surface exploded') } })
  const r = await $.prompt.submit(submit('a@b.co'))
  expect('drop' in r && typeof r.drop === 'string').toBe(true)
})

test('mentioned file is scanned, shown, and sent redacted inside the resubmitted text', async ($, on) => {
  mock.store(on)
  const { submitted } = stub(on, { fs: {
    stat: p => { if (p.endsWith('notes.md')) return { kind: 'file', size: 10, mtimeMs: 0, isLink: false }; throw new Error('ENOENT') },
    read: p => { if (p.endsWith('notes.md')) return 'contact joanna@example.com now'; throw new Error('ENOENT') },
  } })
  expect(await $.prompt.submit(submit('summarise @notes.md please'))).toEqual(HELD)
  const ui = await mount($)
  expect(await ui.find({ text: /@notes\.md/ })).toBeTruthy()
  expect(await ui.find({ text: /1 finding in 2 sections/ })).toBeTruthy()
  await ui.press({ key: 'send' })
  const text = submitted[0]!.text
  expect(text.startsWith('summarise @notes.md please')).toBe(true)
  expect(text).toMatch(/--- @notes\.md \(1 value\(s\) redacted by pii-guard\) ---/)
  expect(text).toMatch(/contact \[EMAIL_1\] now/)
  expect(text).not.toMatch(/joanna@example\.com/)
})

test('Windows and home paths are read ahead', async ($, on) => {
  mock.store(on)
  const seen: string[] = []
  stub(on, { fs: { stat: p => { seen.push(p); throw new Error('ENOENT') } } })
  await $.prompt.submit(submit('see @C:\\Users\\dave\\notes.md and @~/x.txt, then @"a b.txt".'))
  // The engine resolves relative spellings against the working directory; the shapes are what matter.
  expect(seen.length).toBe(3)
  expect(seen[0]).toBe('C:\\Users\\dave\\notes.md')
  expect(seen[1]!.endsWith('x.txt')).toBe(true)
  expect(seen[2]!.endsWith('a b.txt')).toBe(true)
})

test('a stray file attachment is rescanned, redacted and announced', async ($, on) => {
  mock.store(on); const { log } = stub(on)
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  const att = await $.prompt.attachment({ type: 'file', text: 'other.txt\ncard 4111 1111 1111 1111', origin: { kind: 'engine' } } as never)
  expect(att).toEqual({ text: 'other.txt\ncard [CARD_1]' })
  expect(log.some(l => l.startsWith('toast:pii-guard redacted 1 value(s) in an attached file'))).toBe(true)
  const sub = await $.prompt.attachment({ type: 'file', text: 'a@b.co', origin: { kind: 'engine' }, agentId: 'a1' } as never)
  expect(sub).toEqual({ text: 'a@b.co' })
})

test('skips unreadable mentions and directories', async ($, on) => {
  mock.store(on); stub(on)
  expect(await $.prompt.submit(submit('look at @missing.txt and @src/'))).toEqual({ text: 'look at @missing.txt and @src/' })
})

test('allow this session: a later prompt with only that type passes silently', async ($, on) => {
  mock.store(on); const { log, submitted } = stub(on)
  expect(await $.prompt.submit(submit('a@b.co'))).toEqual(HELD)
  const ui = await mount($)
  await ui.press({ key: 'decide:email:allow-session' })
  await ui.press({ key: 'send' })
  expect(submitted[0]!.text).toBe('a@b.co')
  const toastsBefore = log.filter(l => l.startsWith('toast:')).length
  expect(await $.prompt.submit(submit('again c@d.co'))).toEqual({ text: 'again c@d.co' })
  expect(log.filter(l => l.startsWith('toast:')).length).toBe(toastsBefore)
})

test('session-allowed type is listed in settings and revoke re-arms it', async ($, on) => {
  mock.store(on); stub(on)
  expect(await $.prompt.submit(submit('a@b.co'))).toEqual(HELD)
  const ui = await mount($)
  await ui.press({ key: 'decide:email:allow-session' })
  await ui.press({ key: 'send' })
  expect(await ui.find({ key: 'revoke:email' })).toBeTruthy()
  await ui.press({ key: 'revoke:email' })
  expect(await ui.find({ key: 'revoke:email' })).toBeFalsy()
  expect(await $.prompt.submit(submit('c@d.co'))).toEqual(HELD)
})

const readRecord = (content: string) => ({
  ref: 1, text: content, isReadOnly: true as const,
  result: { type: 'text' as const, file: { filePath: 'C:/x/a.txt', content, numLines: 1, startLine: 1, totalLines: 1 } },
})
const readsOn = { config: { version: 1, types: [], watchlist: [], allowlist: [], scanToolReads: true } }

test('Read scanning is off by default', async ($, on) => {
  mock.store(on); stub(on)
  on('tool.call', { tool: 'Read' }, () => readRecord('NI AB 12 34 56 C') as never)
  const r = await $.tool.call({ tool: 'Read', file_path: 'C:/x/a.txt' })
  expect('text' in r && r.text).toBe('NI AB 12 34 56 C')
})

test('with reads on, a hit asks through the engine dialog; redact rewrites the record', async ($, on) => {
  mock.store(on, readsOn); const { opens } = stub(on, { answer: o => o.find(x => x.startsWith('Redact'))! })
  on('tool.call', { tool: 'Read' }, () => readRecord('NI AB 12 34 56 C') as never)
  const r = await $.tool.call({ tool: 'Read', file_path: 'C:/x/a.txt' })
  expect('result' in r && (r.result as { file: { content: string } }).file.content).toBe('NI [NINO_1]')
  expect('context' in r && r.context?.[0]).toMatch(/redacted 1 value/)
  expect(opens()).toBe(1)
})

test('withhold denies the Read result; allow once passes it', async ($, on) => {
  mock.store(on, readsOn)
  let answer = 'Withhold'
  stub(on, { answer: () => answer })
  on('tool.call', { tool: 'Read' }, () => readRecord('a@b.co') as never)
  const denied = await $.tool.call({ tool: 'Read', file_path: 'C:/x/a.txt' })
  expect('deny' in denied && denied.deny).toMatch(/withheld/)
  answer = 'Allow once'
  const allowed = await $.tool.call({ tool: 'Read', file_path: 'C:/x/a.txt' })
  expect('text' in allowed && allowed.text).toBe('a@b.co')
})

test('a Read gate failure after the read ran denies, never passes the raw result', async ($, on) => {
  mock.store(on, readsOn); stub(on, { open: () => { throw new Error('surface exploded') } })
  on('tool.call', { tool: 'Read' }, () => readRecord('a@b.co') as never)
  const r = await $.tool.call({ tool: 'Read', file_path: 'C:/x/a.txt' })
  expect('deny' in r && r.deny).toMatch(/withheld/)
})

test('a clean Read passes untouched with reads on; subagent Reads are not gated', async ($, on) => {
  mock.store(on, readsOn); stub(on)
  on('tool.call', { tool: 'Read' }, ($, e) => readRecord((e as { file_path: string }).file_path.endsWith('clean') ? 'nothing here' : 'a@b.co') as never)
  const clean = await $.tool.call({ tool: 'Read', file_path: 'C:/x/clean' })
  expect('text' in clean && clean.text).toBe('nothing here')
  const sub = await $.tool.call({ tool: 'Read', file_path: 'C:/x/a.txt', agentId: 'sub-1' } as never)
  expect('text' in sub && sub.text).toBe('a@b.co')
})
