import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'
import type { Config, Decision, Finding, Locks, Policy, PolicyStatus, Review, ReviewSection, Unscannable } from '../types'
import {
  STORE_KEY, mergeBuiltins, setEnabled,
  removeType as removeTypeFrom, addTerm as addTermTo, removeTerm as removeTermFrom,
} from './config'
import { scan, redact, placeholderFor, MAX_SCAN } from './detect'
import type { Numbering } from './detect'
import { parsePolicy, applyPolicy, emptyLocks, lockReason } from './policy'
import { patchRecords, scrubArgv } from './scrub'
import { runPiiCommand } from './command'
import { TOOL_SPEC, runPatternsTool } from './tool'
import { paneElements, renderReview, renderSettings } from './review'
import type { PaneActions } from './review'

// State refs and atoms must be literals in this file so the engine can list them.
const PANE_ID = 'pii-guard'
const configVersion = { plugin: 'pii-guard', key: 'configVersion' } as const
const reviewAtom = atom({ plugin: 'pii-guard', key: 'review' } as const, null as Review | null)
const queueAtom = atom({ plugin: 'pii-guard', key: 'queue' } as const, [] as Review[])
const sessionAllowsAtom = atom({ plugin: 'pii-guard', key: 'sessionAllows' } as const, [] as string[])
const settingsOpenAtom = atom({ plugin: 'pii-guard', key: 'settingsOpen' } as const, false)
const pausedAtom = atom({ plugin: 'pii-guard', key: 'paused' } as const, false)

const PLACEHOLDER_NOTE =
  'pii-guard: bracketed placeholders such as [EMAIL_1] or [CARD_2] stand for values the person chose to redact. ' +
  'The same placeholder always means the same value. Do not try to reconstruct them, and never write a placeholder into a file or code in place of the real value: tell the person instead.'

// `$` may not cross an import, so every config call that touches it lives here.

/** The organisation policy: a file path (`policyFile`) and/or inline JSON (`policyJson`); empty for none. */
let policyFile = ''
let policyJson = ''
let policyCache: { mtimeMs: number; policy: Policy; status: PolicyStatus } | null = null
let policyWarned = false
/** Whether the policy option is owned by managed settings; read once per load. */
let managedCache: boolean | null = null

async function isManaged($: EngineInterface): Promise<boolean> {
  if (managedCache !== null) return managedCache
  try {
    const rows = await $.config.list()
    managedCache = rows.some(r => (r.key === 'pii-guard.policyFile' || r.key === 'pii-guard.policyJson') && r.isLocked)
  } catch {
    managedCache = false
  }
  return managedCache
}

/** Merges two policies; `b` adds to `a`, scalar settings from `b` win. */
function mergePolicies(a: Policy, b: Policy): Policy {
  return {
    watchlist: [...a.watchlist, ...b.watchlist],
    allowlist: [...a.allowlist, ...b.allowlist],
    types: { ...a.types, ...b.types },
    customTypes: [...a.customTypes.filter(t => !b.customTypes.some(x => x.id === t.id)), ...b.customTypes],
    scanToolReads: b.scanToolReads ?? a.scanToolReads,
    scrubLog: b.scrubLog ?? a.scrubLog,
    nameDictionary: b.nameDictionary ?? a.nameDictionary,
    enabled: b.enabled ?? a.enabled,
    lists: { ...a.lists, ...b.lists },
  }
}

const noPolicy = (): Policy => ({ watchlist: [], allowlist: [], types: {}, customTypes: [], lists: {} })

/**
 * Reads the policy: inline JSON from the option, then the file (re-read when its
 * modification time changes). A broken source warns once and applies nothing.
 */
async function loadPolicy($: EngineInterface): Promise<{ policy: Policy; status: PolicyStatus } | null> {
  if (!policyFile && !policyJson) return null
  const warnOnce = (text: string) => {
    if (policyWarned) return
    policyWarned = true
    try { $.ui.toast(`pii-guard: policy ${text}`) } catch { /* no surface */ }
    $.ui.log(`pii-guard: policy ${text}`, { to: 'debug' })
  }
  const managed = await isManaged($)
  let inline: Policy = noPolicy()
  const warnings: string[] = []
  if (policyJson) {
    try {
      const parsed = parsePolicy(JSON.parse(policyJson))
      inline = parsed.policy
      warnings.push(...parsed.errors)
    } catch (err) {
      warnOnce(`JSON option could not be parsed (${(err as Error).message}); it is ignored`)
    }
  }
  if (!policyFile) {
    if (warnings.length) warnOnce(`JSON has ${warnings.length} entr${warnings.length === 1 ? 'y' : 'ies'} it could not use; see /pii`)
    return { policy: inline, status: { path: 'inline', loadedAt: Date.now(), error: null, warnings, managed } }
  }
  try {
    const st = await $.fs.stat(policyFile)
    if (policyCache && policyCache.mtimeMs === st.mtimeMs) return policyCache
    const raw = await $.fs.read(policyFile)
    if (typeof raw !== 'string') throw new Error('not a text file')
    const parsed = parsePolicy(JSON.parse(raw))
    const all = [...warnings, ...parsed.errors]
    const status: PolicyStatus = { path: policyFile, loadedAt: Date.now(), error: null, warnings: all, managed }
    policyCache = { mtimeMs: st.mtimeMs, policy: mergePolicies(inline, parsed.policy), status }
    if (all.length) warnOnce(`has ${all.length} entr${all.length === 1 ? 'y' : 'ies'} it could not use; see /pii`)
    return policyCache
  } catch (err) {
    const message = (err as Error).message
    warnOnce(`file could not be read (${message}); ${policyJson ? 'the inline policy' : 'your own settings'} appl${policyJson ? 'ies' : 'y'} alone`)
    return { policy: inline, status: { path: policyFile, loadedAt: null, error: message, warnings, managed } }
  }
}

/** Whether the gate acts right now: enabled (the policy's say wins), and not paused unless the policy enforces it. */
async function isActive($: EngineInterface, eff: Effective): Promise<boolean> {
  if (!eff.config.enabled) return false
  if (eff.locks.enabled) return true
  return !(await read($, pausedAtom))
}

function showGateStatus($: EngineInterface, active: boolean, enabled: boolean): void {
  try { $.ui.status(active ? undefined : enabled ? 'pii-guard paused' : 'pii-guard disabled') } catch { /* no surface */ }
}

type Effective = { user: Config; config: Config; locks: Locks; policy: PolicyStatus | null }

/** The person's stored config, and the config scanning uses once the policy is overlaid. */
async function loadEffective($: EngineInterface): Promise<Effective> {
  const user = mergeBuiltins(await $.store.get(STORE_KEY))
  const loaded = await loadPolicy($)
  if (!loaded) return { user, config: user, locks: emptyLocks(), policy: null }
  const { config, locks } = applyPolicy(user, loaded.policy)
  return { user, config, locks, policy: loaded.status }
}

async function loadConfig($: EngineInterface): Promise<Config> {
  return (await loadEffective($)).config
}

async function saveConfig($: EngineInterface, config: Config): Promise<void> {
  await $.store.set(STORE_KEY, config)
  const { value = 0 } = await $.state.get(configVersion)
  await $.state.set(configVersion, value + 1)
}

/** Set once anything was redacted this session: the model then gets a standing note about placeholders. */
let everRedacted = false

/** The session log's path, learned from the engine's classic UserPromptSubmit event. */
let transcriptPath: string | null = null
let scrubWarned = false

const distinctRedacted = (findings: Finding[], decisions: Record<string, Decision>): string[] =>
  [...new Set(findings.filter(f => (decisions[f.typeId] ?? 'redact') === 'redact').map(f => f.value.trim()).filter(Boolean))]

/**
 * Stars out `values` in the typed-prompt records of the local session log.
 * In place through a child process (any file size); through $.fs for a small
 * log where no child process can run. Best effort: failure warns once.
 */
async function scrubLocalLog($: EngineInterface, config: Config, values: string[]): Promise<void> {
  if (!config.scrubLog || values.length === 0 || !transcriptPath) return
  const path = transcriptPath
  let patched: number | null = null
  try {
    const os = await $.env.get('OS').catch(() => undefined)
    const argv = scrubArgv(os === 'Windows_NT' ? 'windows' : 'posix', path, values)
    const r = await $.process.run(argv, { timeoutMs: 60_000 })
    if (r.exitCode === 0) patched = Number(r.stdout.trim()) || 0
    else $.ui.log(`pii-guard: log scrub exited ${r.exitCode}: ${r.stderr.slice(0, 300)}`, { to: 'debug' })
  } catch (err) {
    $.ui.log(`pii-guard: log scrub child process unavailable: ${(err as Error).message}`, { to: 'debug' })
  }
  if (patched === null) {
    try {
      const st = await $.fs.stat(path)
      if (st.size <= 4 * 1024 * 1024) {
        const text = await $.fs.read(path)
        if (typeof text === 'string') {
          const r = patchRecords(text, values)
          if (r.patched) await $.fs.write(path, r.text)
          patched = r.patched
        }
      }
    } catch (err) {
      $.ui.log(`pii-guard: log scrub through fs failed: ${(err as Error).message}`, { to: 'debug' })
    }
  }
  if (patched === null) {
    if (!scrubWarned) {
      scrubWarned = true
      $.ui.toast('pii-guard: could not scrub the local session log; the typed text remains in it (see debug log)')
    }
  } else if (patched > 0) {
    $.ui.toast(`pii-guard: scrubbed ${patched} local log record(s)`)
  }
}

/** What the last sent prompt agreed, for file attachments the engine raises after it. */
let agreed: { decisions: Record<string, Decision>; numbering: Numbering } | null = null

let reviewSeq = 0

function buildReview(kind: Review['kind'], original: string, sections: ReviewSection[], findings: Finding[], unscannable: Unscannable[]): Review {
  return { id: `r${++reviewSeq}-${Date.now()}`, kind, original, sections, findings, unscannable, decisions: {}, view: 'review' }
}

function sectionOf(id: string, title: string, text: string): ReviewSection {
  return text.length > MAX_SCAN ? { id, title, text, truncated: true } : { id, title, text }
}

const redactAll = (findings: Finding[]): Record<string, Decision> =>
  Object.fromEntries(findings.map(f => [f.typeId, 'redact' as const]))

const typeList = (findings: Finding[]) => [...new Set(findings.map(f => f.typeId))].join(', ')

const sectionText = (review: Review, id: string) => review.sections.find(s => s.id === id)?.text ?? ''

/** `@path` as typed: quoted, or a run up to whitespace with trailing punctuation dropped. */
const MENTION_RE = /(?<![\w@])@(?:"([^"\n]+)"|([^\s"]+))/g

async function mentionedFiles($: EngineInterface, text: string): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(MENTION_RE)) {
    let raw = m[1] ?? m[2] ?? ''
    if (!m[1]) raw = raw.replace(/[.,;:!?)\]}>]+$/, '')
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

async function isSlashCommand($: EngineInterface, text: string): Promise<boolean> {
  const m = /^\s*\/([A-Za-z0-9_:-]+)/.exec(text)
  if (!m) return false
  try {
    const names = new Set((await $.command.list()).map(c => c.name))
    return names.has(m[1]!)
  } catch {
    return false
  }
}

/** Shows `review` in the pane now, or queues it behind the one shown. */
async function showOrQueue($: EngineInterface, review: Review): Promise<void> {
  const current = await read($, reviewAtom)
  if (current) {
    await update($, queueAtom, q => [...q, review])
    return
  }
  await update($, settingsOpenAtom, () => false)
  await update($, reviewAtom, () => review)
  const opened = await $.ui.open({ id: PANE_ID, title: 'PII review', focus: true, closeOnEscape: true, holdToasts: true, rows: 24 })
  if (!opened.isPlaced) $.ui.toast(`pii-guard: a prompt is held for review but the pane cannot be shown (${opened.reason}). Run /pii to open it.`)
}

/** Takes the shown review down and brings the next queued one up, or closes the pane. */
async function advance($: EngineInterface): Promise<void> {
  const q = await read($, queueAtom)
  const [nextReview, ...rest] = q
  await update($, queueAtom, () => rest)
  await update($, reviewAtom, () => nextReview ?? null)
  if (nextReview) {
    await $.ui.open({ id: PANE_ID, title: 'PII review', focus: true, closeOnEscape: true, holdToasts: true, rows: 24 })
  } else if (!(await read($, settingsOpenAtom))) {
    await $.ui.close({ id: PANE_ID }).catch(() => undefined)
  }
}

async function rememberAllows($: EngineInterface, decisions: Record<string, Decision>): Promise<void> {
  const allows = Object.entries(decisions).filter(([, d]) => d === 'allow-session').map(([id]) => id)
  if (allows.length) await update($, sessionAllowsAtom, l => [...new Set([...l, ...allows])])
}

/** Send: redact the held prompt and its files per the decisions, resubmit as the person's own words. */
async function sendReview($: EngineInterface, review: Review): Promise<void> {
  const config = await loadConfig($)
  const ph = (id: string) => placeholderFor(config, id)
  const decisions = review.decisions
  const promptFindings = review.findings.filter(f => f.section === 'prompt')
  const r = redact(review.original, promptFindings, decisions, {}, ph)
  let numbering = r.numbering
  let count = r.count
  // A plugin's prompt has no @file expansion and its own hooks do not see it, so the
  // files the person mentioned ride along in the text, redacted per the decisions.
  const blocks: string[] = []
  for (const section of review.sections) {
    if (!section.id.startsWith('file:')) continue
    const found = review.findings.filter(f => f.section === section.id)
    const fr = redact(section.text, found, decisions, numbering, ph)
    numbering = fr.numbering
    count += fr.count
    blocks.push(`--- ${section.title}${fr.count ? ` (${fr.count} value(s) redacted by pii-guard)` : ''} ---\n${fr.text}\n--- end ${section.title} ---`)
  }
  if (count) everRedacted = true
  await rememberAllows($, decisions)
  agreed = { decisions, numbering }
  await advance($)
  if (count) $.ui.toast(`pii-guard redacted ${count} value(s)`)
  const text = blocks.length ? `${r.text}\n\n${blocks.join('\n\n')}` : r.text
  await $.prompt.submit({ text, asUser: true })
  if (count) await scrubLocalLog($, config, distinctRedacted(review.findings, decisions))
}

/** Cancel: the prompt is discarded, so every flagged value is scrubbed from the local log. */
async function cancelReview($: EngineInterface, review: Review): Promise<void> {
  await advance($)
  $.ui.toast('Prompt cancelled in PII review')
  await scrubLocalLog($, await loadConfig($), distinctRedacted(review.findings, {}))
}

function actionsFor($: EngineInterface): PaneActions {
  // Edits apply to the person's own config and are refused where the policy holds the setting.
  const edit = async (fn: (user: Config, locks: Locks) => Config | string) => {
    const { user, locks } = await loadEffective($)
    const out = fn(user, locks)
    if (typeof out === 'string') { $.ui.toast(`pii-guard: not changed, ${out}`); return }
    await saveConfig($, out)
  }
  const withReview = (fn: (r: Review) => Promise<void>) => void (async () => {
    const r = await read($, reviewAtom)
    if (r) await fn(r)
  })()
  return {
    decide: (typeId, d: Decision) => void update($, reviewAtom, r => r ? { ...r, decisions: { ...r.decisions, [typeId]: d } } : r),
    send: () => withReview(r => sendReview($, r)),
    cancel: () => withReview(r => cancelReview($, r)),
    openSettings: () => void update($, settingsOpenAtom, () => true),
    closeSettings: () => void (async () => {
      await update($, settingsOpenAtom, () => false)
      if (!(await read($, reviewAtom))) await $.ui.close({ id: PANE_ID })
    })(),
    toggleType: (id, on) => void edit((c, locks) => lockReason(locks, { kind: 'type', id }) ?? (() => { const r = setEnabled(c, id, on); return r.ok ? r.config : c })()),
    removeType: id => void edit((c, locks) => lockReason(locks, { kind: 'type', id }) ?? (() => { const r = removeTypeFrom(c, id); return r.ok ? r.config : c })()),
    addTerm: (list, term) => void edit((c, locks) => lockReason(locks, { kind: list === 'allowlist' ? 'allowlist-add' : 'watchlist-add', term }) ?? addTermTo(c, list, term)),
    removeTerm: (list, term) => void edit((c, locks) => lockReason(locks, { kind: list, term }) ?? removeTermFrom(c, list, term)),
    setScanReads: on => void edit((c, locks) => lockReason(locks, { kind: 'scanToolReads' }) ?? { ...c, scanToolReads: on }),
    setScrub: on => void edit((c, locks) => lockReason(locks, { kind: 'scrubLog' }) ?? { ...c, scrubLog: on }),
    setNameDictionary: on => void edit((c, locks) => lockReason(locks, { kind: 'nameDictionary' }) ?? { ...c, nameDictionary: on }),
    setPaused: on => void (async () => {
      const eff = await loadEffective($)
      const held = lockReason(eff.locks, { kind: 'enabled' })
      if (held) { $.ui.toast(`pii-guard: ${held}`); return }
      await update($, pausedAtom, () => on)
      showGateStatus($, !on && eff.config.enabled, eff.config.enabled)
    })(),
    setEnabled: on => void (async () => {
      const eff = await loadEffective($)
      const held = lockReason(eff.locks, { kind: 'enabled' })
      if (held) { $.ui.toast(`pii-guard: ${held}`); return }
      await saveConfig($, { ...eff.user, enabled: on })
      showGateStatus($, on && !(await read($, pausedAtom)), on)
    })(),
    revokeSessionAllow: id => void update($, sessionAllowsAtom, l => l.filter(x => x !== id)),
    allowlistValue: (typeId, value) => void allowlistAndTrim($, value, f => f.typeId === typeId && f.value.trim().toLowerCase() === value.trim().toLowerCase()),
    allowlistWord: (typeId, word) => void allowlistAndTrim($, word, f =>
      f.typeId === typeId && f.value.toLowerCase().split(/[\s-]+/).includes(word.toLowerCase())),
  }
}

/** Adds `term` to the person's allowlist (unless the policy forbids it), drops matching findings from the review shown, and sends if nothing is left. */
async function allowlistAndTrim($: EngineInterface, term: string, matches: (f: Finding) => boolean): Promise<void> {
  const { user, locks } = await loadEffective($)
  const refused = lockReason(locks, { kind: 'allowlist-add', term })
  if (refused) { $.ui.toast(`pii-guard: not changed, ${refused}`); return }
  await saveConfig($, addTermTo(user, 'allowlist', term))
  const review = await read($, reviewAtom)
  if (!review || review.kind !== 'prompt') return
  const remaining = review.findings.filter(f => !matches(f))
  const trimmed: Review = { ...review, findings: remaining }
  await update($, reviewAtom, () => trimmed)
  if (remaining.length === 0 && review.unscannable.length === 0) {
    $.ui.toast(`pii-guard: "${term}" added to the allowlist; nothing left to review, prompt sent`)
    await sendReview($, trimmed)
  }
}

export const register: Register = (on, options) => {
  policyFile = typeof options.policyFile === 'string' ? options.policyFile.trim() : ''
  policyJson = typeof options.policyJson === 'string' ? options.policyJson.trim() : ''
  policyCache = null
  policyWarned = false
  managedCache = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pii',
      description: 'PII guard: settings, patterns, watchlist and allowlist',
      argumentHint: '[list|on|off|add|rm|watch|unwatch|allow|unallow|test|reads]',
    })
    await $.tool.register(TOOL_SPEC)
    try {
      const eff = await loadEffective($)
      showGateStatus($, await isActive($, eff), eff.config.enabled)
    } catch { /* status is cosmetic */ }
    return next(e)
  })

  on('tool.call', { tool: 'mcp__pii-guard__pii_patterns' }, async ($, e) => {
    const { tool, tool_use_id, consent, agentId, requestMeta, ...input } = e as unknown as Record<string, unknown>
    if (agentId) return { result: { ok: false, message: 'pii_patterns is not available to subagents' } }
    const { user, config, locks } = await loadEffective($)
    const outcome = runPatternsTool(user, input, locks, config)
    if (outcome.config) await saveConfig($, outcome.config)
    return { result: outcome.answer }
  })

  on('command.run', { command: 'pii' }, async ($, e) => {
    const eff = await loadEffective($)
    const { user, config, locks } = eff
    const outcome = runPiiCommand(user, e.args, locks, config)
    if (outcome.config) await saveConfig($, outcome.config)
    if (outcome.session) await update($, pausedAtom, () => outcome.session === 'pause')
    if (outcome.session || outcome.config?.enabled !== undefined) {
      const enabled = outcome.config?.enabled ?? config.enabled
      const paused = outcome.session ? outcome.session === 'pause' : await read($, pausedAtom)
      showGateStatus($, enabled && (locks.enabled || !paused), enabled)
    }
    if (outcome.openSettings) {
      await update($, settingsOpenAtom, () => true)
      await $.ui.open({ id: PANE_ID, title: 'PII settings', focus: true, closeOnEscape: true })
      return { text: 'PII guard settings opened.' }
    }
    return { text: outcome.text }
  })

  // The engine's classic event carries the session log's path; keep it for the scrub.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (typeof e.transcript_path === 'string' && e.transcript_path) transcriptPath = e.transcript_path
    return next(e)
  })

  // The person closing the pane (close mark, Escape) while a prompt is held cancels it.
  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      const current = await read($, reviewAtom)
      if (current?.kind === 'prompt') {
        const queued = await read($, queueAtom)
        await update($, queueAtom, () => [])
        await update($, reviewAtom, () => null)
        $.ui.toast('Prompt cancelled in PII review')
        const flagged = [current, ...queued].flatMap(r => r.findings)
        await scrubLocalLog($, await loadConfig($), distinctRedacted(flagged, {}))
      }
    }
    return next(e)
  })

  // Once anything was redacted, the system prompt carries a standing note about placeholders.
  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    if (!everRedacted) return { sections }
    return { sections: [...sections, { id: 'pii-guard:placeholders', text: PLACEHOLDER_NOTE, scope: 'session' as const }] }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin') return next(e)
    if (await isSlashCommand($, e.text)) return next(e)
    agreed = null
    try {
      const eff = await loadEffective($)
      if (!(await isActive($, eff))) return next(e)
      const config = eff.config
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
      const redactEverything = async () => {
        const all = redactAll(findings)
        const r = redact(e.text, promptFindings, all, {}, ph)
        agreed = { decisions: all, numbering: r.numbering }
        if (r.count) everRedacted = true
        const out = await next({ ...e, text: r.text, context: r.count ? [...(e.context ?? []), PLACEHOLDER_NOTE] : e.context })
        if (r.count) await scrubLocalLog($, config, distinctRedacted(findings, all))
        return out
      }

      // Nobody can answer where nothing draws (a -p run). The desktop app is SDK-hosted
      // and reports isInteractive=false, so the surfaces attached now are the test.
      if ((await $.session.surfaces()).length === 0) {
        $.ui.log(`pii-guard: non-interactive session, redacted ${promptFindings.length} value(s) of ${typeList(findings)}`, { to: 'debug' })
        return redactEverything()
      }

      if (unscannable.length > 0) {
        // Attachments cannot survive a resubmit, so this prompt is decided in the
        // engine's dialog (a `$` call, which does not count against the hook's time)
        // while the pane shows what was found.
        const review = buildReview('prompt', e.text, sections, findings, unscannable)
        await update($, settingsOpenAtom, () => false)
        await update($, reviewAtom, () => review)
        await $.ui.open({ id: PANE_ID, title: 'PII review', holdToasts: true, rows: 24 })
        const what = `${unscannable.length} attachment(s) that cannot be scanned` + (findings.length ? ` and ${findings.length} PII value(s) in the text (${typeList(findings)})` : '')
        const options = findings.length ? ['Redact text and send', 'Send everything as-is', 'Cancel'] : ['Send', 'Cancel']
        const answer = await $.ui.ask(`pii-guard: this prompt carries ${what}. What now?`, { options, header: 'PII guard' }).catch(() => 'Cancel')
        await update($, reviewAtom, () => null)
        await $.ui.close({ id: PANE_ID }).catch(() => undefined)
        if (answer === 'Redact text and send') return redactEverything()
        if (answer === 'Send everything as-is' || answer === 'Send') return next(e)
        await scrubLocalLog($, config, distinctRedacted(findings, {}))
        return { drop: 'Cancelled in PII review' }
      }

      await showOrQueue($, buildReview('prompt', e.text, sections, findings, unscannable))
      return { drop: 'Held for PII review' }
    } catch (err) {
      $.ui.log(`pii-guard: prompt.submit failed, prompt held: ${(err as Error).message}`, { to: 'debug' })
      try { $.ui.toast('pii-guard failed, prompt held. See debug log.') } catch { /* no surface */ }
      return { drop: 'pii-guard failed; prompt held' }
    }
  }).catch(($, e, next) => (next.called ? next(e) : { drop: 'pii-guard failed; prompt held' }))

  // Opt-in: a Read result with PII is decided in the engine's dialog (a `$` call) while
  // the pane shows the hit. Any failure after the read ran withholds the result.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError || e.agentId) return ran
    try {
      const eff = await loadEffective($)
      if (!(await isActive($, eff))) return ran
      const config = eff.config
      if (!config.scanToolReads) return ran
      const record = ran.result as { type?: string; file?: { content?: string } } | undefined
      const content = record?.type === 'text' && typeof record.file?.content === 'string' ? record.file.content : undefined
      if (content === undefined) return ran
      const sessionAllows = await read($, sessionAllowsAtom)
      const sectionId = `tool:${e.tool_use_id ?? 'read'}`
      const findings = scan(content, sectionId, config, { sessionAllows })
      if (findings.length === 0) return ran

      const review = buildReview('tool', '', [sectionOf(sectionId, `Read ${e.file_path}`, content)], findings, [])
      const held = await read($, reviewAtom)
      if (!held) {
        await update($, settingsOpenAtom, () => false)
        await update($, reviewAtom, () => review)
        await $.ui.open({ id: PANE_ID, title: 'PII review (Read)', holdToasts: true, rows: 24 })
      }
      const answer = await $.ui.ask(
        `pii-guard: the Read of ${e.file_path} holds ${findings.length} PII value(s) (${typeList(findings)}). What should Claude see?`,
        { options: ['Redact and continue', 'Allow once', 'Allow this session', 'Withhold'], header: 'PII guard' },
      ).catch(() => 'Withhold')
      if (!held) {
        await update($, reviewAtom, () => null)
        await $.ui.close({ id: PANE_ID }).catch(() => undefined)
      }
      if (answer === 'Allow once') return ran
      if (answer === 'Allow this session') {
        await update($, sessionAllowsAtom, l => [...new Set([...l, ...findings.map(f => f.typeId)])])
        return ran
      }
      if (answer !== 'Redact and continue') return { deny: 'Read result withheld in PII review' }
      const r = redact(content, findings, redactAll(findings), {}, id => placeholderFor(config, id))
      everRedacted = true
      const file = (ran.result as { file: Record<string, unknown> }).file
      return {
        result: { ...(ran.result as object), file: { ...file, content: r.text } } as typeof ran.result,
        context: [`pii-guard redacted ${r.count} value(s) in this file before you read it. ${PLACEHOLDER_NOTE}`],
      }
    } catch (err) {
      $.ui.log(`pii-guard: Read gate failed, result withheld: ${(err as Error).message}`, { to: 'debug' })
      return { deny: 'pii-guard failed; Read withheld' }
    }
  }).catch(() => ({ deny: 'pii-guard failed; Read withheld' }))

  // Every main-loop file attachment is rescanned with the current config; the
  // decisions are the ones the last sent prompt agreed, redact for anything else.
  on('prompt.attachment', { type: 'file' }, async ($, e, next) => {
    if (e.agentId) return next(e)
    const eff = await loadEffective($)
    if (!(await isActive($, eff))) return next(e)
    const config = eff.config
    const sessionAllows = await read($, sessionAllowsAtom)
    const findings = scan(e.text, 'attachment', config, { sessionAllows })
    if (findings.length === 0) return next(e)
    const r = redact(e.text, findings, agreed?.decisions ?? {}, agreed?.numbering ?? {}, id => placeholderFor(config, id))
    if (agreed) agreed = { ...agreed, numbering: r.numbering }
    if (r.count) { everRedacted = true; $.ui.toast(`pii-guard redacted ${r.count} value(s) in an attached file`) }
    return next({ ...e, text: r.text })
  }).catch(($, e, next) => (next.called ? next(e) : { text: null }))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const E = paneElements($.ui.resolve(e))
    const [review, queue, allows, settingsOpen, effective, paused] = await Promise.all([
      read($, reviewAtom), read($, queueAtom), read($, sessionAllowsAtom), read($, settingsOpenAtom), loadEffective($), read($, pausedAtom),
    ])
    // Subscribes this drawing to config saves, which bump configVersion.
    await $.state.get(configVersion)
    const actions = actionsFor($)
    if (settingsOpen || !review) {
      return renderSettings(E, effective.config, allows, review !== null, actions, effective.locks, effective.policy, paused)
    }
    return renderReview(E, review, effective.config, actions, queue.length, e.props.bodyColumns)
  })
}
