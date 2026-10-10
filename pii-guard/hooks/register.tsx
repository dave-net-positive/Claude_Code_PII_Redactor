import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'
import type { Config, Decision, Finding, Review, ReviewSection, Unscannable } from '../types'
import {
  STORE_KEY, mergeBuiltins, setEnabled,
  removeType as removeTypeFrom, addTerm as addTermTo, removeTerm as removeTermFrom,
} from './config'
import { scan, redact, placeholderFor, MAX_SCAN } from './detect'
import type { Numbering } from './detect'
import { runPiiCommand } from './command'
import { TOOL_SPEC, runPatternsTool } from './tool'
import { paneElements, renderReview, renderSettings } from './review'
import type { PaneActions } from './review'

// State refs and atoms must be literals in this file so the engine can list them.
const PANE_ID = 'pii-guard'
const configVersion = { plugin: 'pii-guard', key: 'configVersion' } as const
const reviewAtom = atom({ plugin: 'pii-guard', key: 'review' } as const, null as Review | null)
const sessionAllowsAtom = atom({ plugin: 'pii-guard', key: 'sessionAllows' } as const, [] as string[])
const settingsOpenAtom = atom({ plugin: 'pii-guard', key: 'settingsOpen' } as const, false)

// `$` may not cross an import, so the two config calls that touch it live here.
async function loadConfig($: EngineInterface): Promise<Config> {
  return mergeBuiltins(await $.store.get(STORE_KEY))
}

async function saveConfig($: EngineInterface, config: Config): Promise<void> {
  await $.store.set(STORE_KEY, config)
  const { value = 0 } = await $.state.get(configVersion)
  await $.state.set(configVersion, value + 1)
}

type Outcome = 'send' | 'cancel'
let pending: ((o: Outcome) => void) | null = null
const settle = (o: Outcome) => { const p = pending; pending = null; p?.(o) }
// Decisions are mirrored here because a hook's state reads all see the moment
// its dispatch began: presses that land while it awaits are invisible to it.
let liveDecisions: Record<string, Decision> = {}

let reviewSeq = 0

function buildReview(kind: Review['kind'], sections: ReviewSection[], findings: Finding[], unscannable: Unscannable[]): Review {
  return { id: `r${++reviewSeq}`, kind, sections, findings, unscannable, decisions: {}, view: 'review' }
}

function sectionOf(id: string, title: string, text: string): ReviewSection {
  return text.length > MAX_SCAN ? { id, title, text, truncated: true } : { id, title, text }
}

const redactAll = (findings: Finding[]): Record<string, Decision> =>
  Object.fromEntries(findings.map(f => [f.typeId, 'redact' as const]))

const typeList = (findings: Finding[]) => [...new Set(findings.map(f => f.typeId))].join(', ')

/**
 * What the last prompt's review agreed, for the file attachments that follow it.
 * Attachments are rescanned rather than matched by path: an attachment that
 * cannot be attributed is still redacted (default decision), never passed through.
 */
let agreed: { decisions: Record<string, Decision>; numbering: Numbering } | null = null

const MENTION_RE = /(?<![\w@])@((?:"[^"\n]+")|(?:[^\s"'`,;:!?()[\]{}<>]+))/g

async function mentionedFiles($: EngineInterface, text: string): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(MENTION_RE)) {
    let raw = m[1]!.replace(/^"|"$/g, '')
    raw = raw.replace(/#L\d+(?:-\d+)?$/, '')
    if (!raw || seen.has(raw)) continue
    seen.add(raw)
    try {
      const st = await $.fs.stat(raw)
      if (st.kind !== 'file' || st.size > 4 * 1024 * 1024) continue
      const body = await $.fs.read(raw)
      if (typeof body === 'string') out.push({ path: raw, text: body })
    } catch { /* missing, a directory, denied: skip */ }
  }
  return out
}

/** Shows the review pane, waits for Send / Cancel / close, applies session allows. */
async function runReview($: EngineInterface, review: Review): Promise<{ outcome: Outcome; decisions: Record<string, Decision> }> {
  settle('cancel') // a stale pending review loses
  liveDecisions = {}
  await update($, settingsOpenAtom, () => false)
  await update($, reviewAtom, () => review)
  const outcomeP = new Promise<Outcome>(resolve => { pending = resolve })
  let outcome: Outcome
  try {
    const opened = await $.ui.open({
      id: PANE_ID,
      title: review.kind === 'tool' ? 'PII review (Read)' : 'PII review',
      focus: true, closeOnEscape: true, holdToasts: true, rows: 24,
    })
    if (!opened.isPlaced) {
      const answer = await $.ui.ask(
        `pii-guard found ${review.findings.length} PII value(s) but cannot show the review pane (${opened.reason}). What now?`,
        ['Redact all and continue', 'Cancel'],
      ).catch(() => 'Cancel')
      settle(answer === 'Redact all and continue' ? 'send' : 'cancel')
    }
    outcome = await outcomeP
  } finally {
    pending = null
  }
  const decisions = { ...liveDecisions }
  liveDecisions = {}
  await update($, reviewAtom, () => null)
  await $.ui.close({ id: PANE_ID }).catch(() => undefined)
  if (outcome === 'send') {
    const allows = Object.entries(decisions).filter(([, d]) => d === 'allow-session').map(([id]) => id)
    if (allows.length) await update($, sessionAllowsAtom, l => [...new Set([...l, ...allows])])
  }
  return { outcome, decisions }
}

function actionsFor($: EngineInterface): PaneActions {
  const edit = async (fn: (c: Config) => Config) => saveConfig($, fn(await loadConfig($)))
  return {
    decide: (typeId, d: Decision) => {
      liveDecisions = { ...liveDecisions, [typeId]: d }
      void update($, reviewAtom, r => r ? { ...r, decisions: { ...r.decisions, [typeId]: d } } : r)
    },
    send: () => settle('send'),
    cancel: () => settle('cancel'),
    openSettings: () => void update($, settingsOpenAtom, () => true),
    closeSettings: () => void (async () => {
      await update($, settingsOpenAtom, () => false)
      if (!(await read($, reviewAtom))) await $.ui.close({ id: PANE_ID })
    })(),
    toggleType: (id, on) => void edit(c => { const r = setEnabled(c, id, on); return r.ok ? r.config : c }),
    removeType: id => void edit(c => { const r = removeTypeFrom(c, id); return r.ok ? r.config : c }),
    addTerm: (list, term) => void edit(c => addTermTo(c, list, term)),
    removeTerm: (list, term) => void edit(c => removeTermFrom(c, list, term)),
    setScanReads: on => void edit(c => ({ ...c, scanToolReads: on })),
    revokeSessionAllow: id => void update($, sessionAllowsAtom, l => l.filter(x => x !== id)),
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pii',
      description: 'PII guard: settings, patterns, watchlist and allowlist',
      argumentHint: '[list|on|off|add|rm|watch|unwatch|allow|unallow|test|reads]',
    })
    await $.tool.register(TOOL_SPEC)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__pii-guard__pii_patterns' }, async ($, e) => {
    const { tool, tool_use_id, consent, agentId, requestMeta, ...input } = e as unknown as Record<string, unknown>
    const outcome = runPatternsTool(await loadConfig($), input)
    if (outcome.config) await saveConfig($, outcome.config)
    return { result: outcome.answer }
  })

  on('command.run', { command: 'pii' }, async ($, e) => {
    const outcome = runPiiCommand(await loadConfig($), e.args)
    if (outcome.config) await saveConfig($, outcome.config)
    if (outcome.openSettings) {
      await update($, settingsOpenAtom, () => true)
      await $.ui.open({ id: PANE_ID, title: 'PII settings', focus: true, closeOnEscape: true })
      return { text: 'PII guard settings opened.' }
    }
    return { text: outcome.text }
  })

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    if (e.origin.kind === 'person' && pending) settle('cancel')
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin') return next(e)
    if (/^\s*\//.test(e.text)) return next(e)
    agreed = null
    try {
      const config = await loadConfig($)
      const sessionAllows = await read($, sessionAllowsAtom)
      const sections: ReviewSection[] = [sectionOf('prompt', 'Prompt', e.text)]
      const findings: Finding[] = scan(e.text, 'prompt', config, { sessionAllows })
      for (const f of await mentionedFiles($, e.text)) {
        const id = `file:${f.path}`
        sections.push(sectionOf(id, `@${f.path}`, f.text))
        findings.push(...scan(f.text, id, config, { sessionAllows }))
      }
      const unscannable: Unscannable[] = (e.attachments ?? []).map(a => ({ filename: a.filename, type: a.type, mediaType: a.mediaType }))
      if (findings.length === 0 && unscannable.length === 0) return next(e)

      const ph = (id: string) => placeholderFor(config, id)
      const promptFindings = findings.filter(f => f.section === 'prompt')
      if (e.origin.kind === 'sdk') {
        const all = redactAll(findings)
        const r = redact(e.text, promptFindings, all, {}, ph)
        agreed = { decisions: all, numbering: r.numbering }
        $.ui.log(`pii-guard: headless run, redacted ${r.count} value(s) of ${typeList(findings)}`, { to: 'debug' })
        return next({ ...e, text: r.text })
      }

      const { outcome, decisions } = await runReview($, buildReview('prompt', sections, findings, unscannable))
      if (outcome === 'cancel') {
        $.ui.toast('Prompt cancelled in PII review')
        return { drop: 'Cancelled in PII review' }
      }
      const r = redact(e.text, promptFindings, decisions, {}, ph)
      agreed = { decisions, numbering: r.numbering }
      if (r.count) $.ui.toast(`pii-guard redacted ${r.count} value(s)`)
      return next({ ...e, text: r.text })
    } catch (err) {
      $.ui.log(`pii-guard: prompt.submit failed, prompt held: ${(err as Error).message}`, { to: 'debug' })
      try { $.ui.toast('pii-guard failed, prompt held. See debug log.') } catch { /* no surface */ }
      return { drop: 'pii-guard failed; prompt held' }
    }
  }).catch(($, e, next) => (next.called ? next(e) : { drop: 'pii-guard failed; prompt held' }))

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError || e.agentId) return ran
    const config = await loadConfig($)
    if (!config.scanToolReads) return ran
    const record = ran.result as { type?: string; file?: { content?: string } } | undefined
    const content = record?.type === 'text' && typeof record.file?.content === 'string' ? record.file.content : undefined
    if (content === undefined) return ran
    const sessionAllows = await read($, sessionAllowsAtom)
    const sectionId = `tool:${e.tool_use_id ?? 'read'}`
    const findings = scan(content, sectionId, config, { sessionAllows })
    if (findings.length === 0) return ran
    const review = buildReview('tool', [sectionOf(sectionId, `Read ${e.file_path}`, content)], findings, [])
    const { outcome, decisions } = await runReview($, review)
    if (outcome === 'cancel') return { deny: 'Read result withheld in PII review' }
    const r = redact(content, findings, decisions, {}, id => placeholderFor(config, id))
    if (r.count === 0) return ran
    const file = (ran.result as { file: Record<string, unknown> }).file
    return {
      result: { ...(ran.result as object), file: { ...file, content: r.text } } as typeof ran.result,
      context: [`pii-guard redacted ${r.count} value(s) in this file before you read it. Placeholders like [NINO_1] stand for real values; do not try to reconstruct them.`],
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'pii-guard failed; Read withheld' }))

  // Every main-loop file attachment is rescanned with the current config; the
  // decisions are the ones the prompt's review agreed, redact for anything else.
  on('prompt.attachment', { type: 'file' }, async ($, e, next) => {
    if (e.agentId) return next(e)
    const config = await loadConfig($)
    const sessionAllows = await read($, sessionAllowsAtom)
    const findings = scan(e.text, 'attachment', config, { sessionAllows })
    if (findings.length === 0) return next(e)
    const r = redact(e.text, findings, agreed?.decisions ?? {}, agreed?.numbering ?? {}, id => placeholderFor(config, id))
    if (agreed) agreed = { ...agreed, numbering: r.numbering }
    return next({ ...e, text: r.text })
  }).catch(($, e, next) => (next.called ? next(e) : { text: null }))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const E = paneElements($.ui.resolve(e))
    const [review, allows, settingsOpen, config] = await Promise.all([
      read($, reviewAtom), read($, sessionAllowsAtom), read($, settingsOpenAtom), loadConfig($),
    ])
    // Subscribes this drawing to config saves, which bump configVersion.
    await $.state.get(configVersion)
    const actions = actionsFor($)
    if (settingsOpen || !review) {
      return renderSettings(E, config, allows, review !== null, actions)
    }
    return renderReview(E, review, config, actions)
  })
}
