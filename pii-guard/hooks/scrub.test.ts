import { test, expect } from 'claude-code/testing'
import { jsonNeedle, patchRecords, scrubArgv } from './scrub'

const queueLine = (text: string) => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: text, sessionId: 's', timestamp: 't' })
const userLine = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
const lastPromptLine = (text: string) => JSON.stringify({ type: 'last-prompt', lastPrompt: text, leafUuid: 'u' })

test('jsonNeedle matches how the value is written inside a JSON string', async () => {
  expect(jsonNeedle('plain')).toBe('plain')
  expect(jsonNeedle('say "hi"')).toBe('say \\"hi\\"')
  expect(jsonNeedle('a\\b')).toBe('a\\\\b')
})

test('patchRecords stars out values in queue and last-prompt records only, keeping every length', async () => {
  const raw = 'call Mary Robinson on 07700 900123'
  const content = [queueLine(raw), userLine('call [NAME_1] on [PHONE_1]'), userLine(raw), lastPromptLine(raw), '{"type":"other"}'].join('\n')
  const { text, patched } = patchRecords(content, ['Mary Robinson', '07700 900123'])
  const lines = text.split('\n')
  expect(patched).toBe(2)
  expect(text.length).toBe(content.length)
  expect(lines[0]).toContain('call ************* on ************')
  expect(lines[0]).not.toContain('Mary Robinson')
  expect(lines[3]).not.toContain('07700 900123')
  // the conversation messages are left alone, even one that still holds the value
  expect(lines[2]).toBe(userLine(raw))
  expect(lines[1]).toBe(userLine('call [NAME_1] on [PHONE_1]'))
})

test('patchRecords leaves the file untouched when nothing matches', async () => {
  const content = [queueLine('hello'), userLine('hello')].join('\n')
  expect(patchRecords(content, ['nope'])).toEqual({ text: content, patched: 0 })
})

test('scrubArgv builds a PowerShell command on Windows and a perl command elsewhere', async () => {
  const win = scrubArgv('windows', 'C:\\Users\\d\\.claude\\projects\\x\\s.jsonl', ['Mary Robinson'])
  expect(win[0]).toBe('powershell')
  expect(win).toContain('-NoProfile')
  expect(win.join(' ')).not.toContain('Mary Robinson')
  const posix = scrubArgv('posix', '/home/d/.claude/projects/x/s.jsonl', ['Mary Robinson'])
  expect(posix[0]).toBe('perl')
  expect(posix.join(' ')).not.toContain('Mary Robinson')
})
