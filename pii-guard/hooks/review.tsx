import type { ElementTable, RenderSurface } from 'claude-code'
import type { Config, Decision, Finding, Review, ReviewSection } from '../types'
import { CATEGORY_COLOR } from './patterns'
import { placeholderFor } from './detect'

export type PaneActions = {
  decide(typeId: string, d: Decision): void
  send(): void
  cancel(): void
  openSettings(): void
  closeSettings(): void
  toggleType(id: string, on: boolean): void
  removeType(id: string): void
  addTerm(list: 'watchlist' | 'allowlist', term: string): void
  removeTerm(list: 'watchlist' | 'allowlist', term: string): void
  setScanReads(on: boolean): void
  revokeSessionAllow(id: string): void
}

/** The elements every surface has; `Input` is looked up separately where a surface draws one. */
type Common = Pick<ElementTable<'terminal'>, 'Box' | 'Text' | 'Button'>
type MaybeInput = { Input?: ElementTable<'terminal'>['Input'] }
export type PaneElements = Common & MaybeInput

export function paneElements(table: ElementTable<RenderSurface>): PaneElements {
  const { Box, Text, Button } = table
  const Input = 'Input' in table ? (table as ElementTable<'terminal'>).Input : undefined
  return { Box, Text, Button, Input }
}

const CONTEXT_LINES = 3
const TRIM_OVER_LINES = 40
const DECISIONS: readonly Decision[] = ['allow-once', 'allow-session', 'redact']
const DECISION_LABEL: Record<Decision, string> = {
  'allow-once': 'Allow once',
  'allow-session': 'Allow this session',
  redact: 'Redact',
}

const bareId = (id: string) => id.replace(/^custom:/, '')

type Run = { text: string; finding?: Finding }

function runs(text: string, findings: Finding[]): Run[] {
  const out: Run[] = []
  let cursor = 0
  for (const f of [...findings].sort((a, b) => a.start - b.start)) {
    if (f.start < cursor) continue
    if (f.start > cursor) out.push({ text: text.slice(cursor, f.start) })
    out.push({ text: text.slice(f.start, f.end), finding: f })
    cursor = f.end
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor) })
  return out
}

type Window = { text: string; offset: number }

function windowsOf(section: ReviewSection, findings: Finding[]): Window[] {
  const lines = section.text.split('\n')
  if (lines.length <= TRIM_OVER_LINES) return [{ text: section.text, offset: 0 }]
  const starts: number[] = []
  let pos = 0
  for (const l of lines) { starts.push(pos); pos += l.length + 1 }
  const keep = new Set<number>()
  for (const f of findings) {
    let line = 0
    for (let i = 0; i < starts.length; i++) if (starts[i]! <= f.start) line = i
    for (let i = Math.max(0, line - CONTEXT_LINES); i <= Math.min(lines.length - 1, line + CONTEXT_LINES); i++) keep.add(i)
  }
  const out: Window[] = []
  let i = 0
  while (i < lines.length) {
    if (!keep.has(i)) { i++; continue }
    const from = i
    while (i < lines.length && keep.has(i)) i++
    out.push({ text: lines.slice(from, i).join('\n'), offset: starts[from]! })
  }
  return out
}

function sectionBlock(E: PaneElements, section: ReviewSection, all: Finding[], config: Config) {
  const { Box, Text } = E
  const findings = all.filter(f => f.section === section.id)
  const windows = windowsOf(section, findings)
  const lineCount = section.text.split('\n').length
  const trimmed = lineCount > TRIM_OVER_LINES
  const colorOf = (f: Finding) => CATEGORY_COLOR[config.types.find(t => t.id === f.typeId)?.category ?? 'custom']
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>
        {section.title}
        {section.truncated ? '  (scan capped at 200,000 characters)' : ''}
        {trimmed ? `  (context around findings, ${lineCount} lines)` : ''}
      </Text>
      {windows.map((w, wi) => {
        const local = findings
          .filter(f => f.start >= w.offset && f.end <= w.offset + w.text.length)
          .map(f => ({ ...f, start: f.start - w.offset, end: f.end - w.offset }))
        return (
          <Box flexDirection="column">
            {wi > 0 ? <Text dimColor>…</Text> : null}
            <Text wrap="wrap">
              {runs(w.text, local).map(r => r.finding
                ? [
                    <Text inverse color={colorOf(r.finding)}>{r.text}</Text>,
                    <Text dimColor>{` [${placeholderFor(config, r.finding.typeId)}]`}</Text>,
                  ]
                : r.text)}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

export function renderReview(E: PaneElements, review: Review, config: Config, actions: PaneActions) {
  const { Box, Text, Button } = E
  const order: string[] = []
  for (const f of review.findings) if (!order.includes(f.typeId)) order.push(f.typeId)
  const count = (id: string) => review.findings.filter(f => f.typeId === id).length
  const current = (id: string): Decision => review.decisions[id] ?? 'redact'
  const redactions = order.reduce((n, id) => n + (current(id) === 'redact' ? count(id) : 0), 0)
  const label = (id: string) => config.types.find(t => t.id === id)?.label ?? id
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="warning">
        {`PII review: ${plural(review.findings.length, 'finding')} in ${plural(review.sections.length, 'section')}`}
        {review.unscannable.length ? `, ${plural(review.unscannable.length, 'attachment')} cannot be scanned` : ''}
      </Text>
      <Text dimColor>
        {review.kind === 'tool' ? 'A Read result is held until you decide.' : 'The prompt is held until you decide. Escape cancels.'}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {review.sections.map(s => sectionBlock(E, s, review.findings, config))}
      </Box>
      {order.length > 0 ? <Text bold>Detected types</Text> : null}
      {order.map(id => (
        <Box gap={1}>
          <Text bold>{label(id)}</Text>
          <Text dimColor>{`×${count(id)}`}</Text>
          {DECISIONS.map(d => (
            <Button
              key={`decide:${id}:${d}`}
              label={(current(id) === d ? '● ' : '○ ') + DECISION_LABEL[d]}
              onPress={() => actions.decide(id, d)}
            />
          ))}
        </Box>
      ))}
      {review.unscannable.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Cannot be scanned</Text>
          {review.unscannable.map(u => (
            <Text>{`• ${u.filename ?? '(unnamed)'} (${u.mediaType ?? u.type}): Send will include it as-is`}</Text>
          ))}
        </Box>
      ) : null}
      <Box gap={2} marginTop={1}>
        <Button key="send" hotkey="s" label={redactions ? `Send with ${plural(redactions, 'redaction')}` : 'Send'} onPress={() => actions.send()} />
        <Button key="cancel" hotkey="c" label="Cancel" onPress={() => actions.cancel()} />
        <Button key="settings" hotkey="o" label="Settings" onPress={() => actions.openSettings()} />
      </Box>
    </Box>
  )
}

export function renderSettings(E: PaneElements, config: Config, sessionAllows: string[], hasReview: boolean, actions: PaneActions) {
  const { Box, Text, Button, Input } = E
  const byCategory = new Map<string, Config['types']>()
  for (const t of config.types) byCategory.set(t.category, [...(byCategory.get(t.category) ?? []), t])
  const list = (name: 'watchlist' | 'allowlist', title: string, hint: string) => {
    const prefix = name === 'watchlist' ? 'watch' : 'allow'
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>{title}</Text>
        {config[name].length === 0 ? <Text dimColor>(empty)</Text> : null}
        {config[name].map(term => (
          <Box gap={1}>
            <Text>{term}</Text>
            <Button key={`${prefix}:remove:${term}`} label="Remove" plain onPress={() => actions.removeTerm(name, term)} />
          </Box>
        ))}
        {Input
          ? <Input key={`${prefix}:add`} placeholder={hint} submitLabel="Add" onSubmit={v => actions.addTerm(name, v)} />
          : <Text dimColor>{`Add with /pii ${prefix} <term> (this surface has no text field)`}</Text>}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="warning">PII guard settings</Text>
      {[...byCategory.entries()].map(([cat, types]) => (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{cat}</Text>
          {types.map(t => (
            <Box gap={1}>
              <Text>{`${t.enabled ? '◼' : '◻'} ${t.label}`}</Text>
              <Text dimColor>{t.id}</Text>
              <Button
                key={`type:${bareId(t.id)}:${t.enabled ? 'off' : 'on'}`}
                label={t.enabled ? 'Turn off' : 'Turn on'}
                plain
                onPress={() => actions.toggleType(t.id, !t.enabled)}
              />
              {t.source === 'custom'
                ? <Button key={`type:${bareId(t.id)}:remove`} label="Remove" plain onPress={() => actions.removeType(t.id)} />
                : null}
              {t.source === 'custom' ? <Text dimColor>{`/${t.patterns[0]}/`}</Text> : null}
            </Box>
          ))}
        </Box>
      ))}
      {list('watchlist', 'Names watchlist', 'Add name or term')}
      {list('allowlist', 'Allowlist (never reported)', 'Add false positive')}
      <Box gap={1} marginTop={1}>
        <Text bold>Scan Read tool results:</Text>
        <Text>{config.scanToolReads ? 'on' : 'off'}</Text>
        <Button
          key={config.scanToolReads ? 'reads:off' : 'reads:on'}
          label={config.scanToolReads ? 'Turn off' : 'Turn on'}
          plain
          onPress={() => actions.setScanReads(!config.scanToolReads)}
        />
      </Box>
      {sessionAllows.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Allowed for this session</Text>
          {sessionAllows.map(id => (
            <Box gap={1}>
              <Text>{id}</Text>
              <Button key={`revoke:${id}`} label="Revoke" plain onPress={() => actions.revokeSessionAllow(id)} />
            </Box>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Button key="back" hotkey="b" label={hasReview ? 'Back to review' : 'Close'} onPress={() => actions.closeSettings()} />
      </Box>
    </Box>
  )
}
