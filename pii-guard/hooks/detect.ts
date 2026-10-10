import type { Config, Decision, Finding, PiiType } from '../types'
import { VALIDATORS } from './patterns'

export const MAX_SCAN = 200_000
const MAX_PATTERN = 500

export type Compiled = { ok: true; regex: RegExp } | { ok: false; reason: string }

const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[*+]\s*(?:[^()\\]|\\.)*\)\s*[*+{]/
const ALTERNATION_IN_QUANTIFIED_GROUP = /\((?:[^()\\|]|\\.)*\|(?:[^()\\]|\\.)*\)\s*[*+{]/

export function compilePattern(source: string, flags: 'giu' | 'gu' = 'giu'): Compiled {
  if (typeof source !== 'string' || source.length === 0) return { ok: false, reason: 'pattern is empty' }
  if (source.length > MAX_PATTERN) return { ok: false, reason: `pattern is longer than ${MAX_PATTERN} characters` }
  if (NESTED_QUANTIFIER.test(source)) return { ok: false, reason: 'a quantified group contains a quantifier (catastrophic backtracking risk), rewrite without nesting' }
  if (ALTERNATION_IN_QUANTIFIED_GROUP.test(source)) return { ok: false, reason: 'a quantified group contains alternation (catastrophic backtracking risk), make the branches mutually exclusive or drop the quantifier' }
  let regex: RegExp
  try { regex = new RegExp(source, flags) } catch (err) {
    return { ok: false, reason: `does not compile: ${(err as Error).message}` }
  }
  regex.lastIndex = 0
  if (regex.test('')) return { ok: false, reason: 'pattern matches the empty string' }
  regex.lastIndex = 0
  return { ok: true, regex }
}

const compiledCache = new Map<string, RegExp | null>()
function compiled(source: string, caseSensitive: boolean): RegExp | null {
  const key = (caseSensitive ? 's:' : 'i:') + source
  const hit = compiledCache.get(key)
  if (hit !== undefined) return hit
  const c = compilePattern(source, caseSensitive ? 'gu' : 'giu')
  const r = c.ok ? c.regex : null
  compiledCache.set(key, r)
  return r
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export type ScanOptions = { sessionAllows?: readonly string[] }

function collect(regex: RegExp, text: string, type: PiiType, section: string, out: Finding[]) {
  regex.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = regex.exec(text)) !== null) {
    if (m[0].length === 0) { regex.lastIndex++; continue }
    out.push({ typeId: type.id, value: m[0], start: m.index, end: m.index + m[0].length, section })
  }
}

export function scan(text: string, section: string, config: Config, opts: ScanOptions = {}): Finding[] {
  const body = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text
  const allow = new Set(config.allowlist.map(s => s.trim().toLowerCase()))
  const skip = new Set(opts.sessionAllows ?? [])
  const raw: Finding[] = []
  for (const type of config.types) {
    if (!type.enabled || skip.has(type.id)) continue
    const validator = VALIDATORS[type.validator] ?? VALIDATORS.none
    const hits: Finding[] = []
    for (const src of type.patterns) {
      const re = compiled(src, type.caseSensitive === true)
      if (re) collect(re, body, type, section, hits)
    }
    if (type.id === 'name') {
      for (const term of config.watchlist) {
        const trimmed = term.trim()
        if (!trimmed) continue
        const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(trimmed)}(?![\\p{L}\\p{N}])`, 'giu')
        collect(re, body, type, section, hits)
      }
    }
    for (const h of hits) {
      if (!validator(h.value)) continue
      if (allow.has(h.value.trim().toLowerCase())) continue
      raw.push(h)
    }
  }
  raw.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))
  const out: Finding[] = []
  let lastEnd = -1
  for (const f of raw) {
    if (f.start < lastEnd) continue
    out.push(f)
    lastEnd = f.end
  }
  return out
}

export type Numbering = Record<string, Record<string, number>>

export function placeholderFor(config: Config, typeId: string): string {
  return config.types.find(t => t.id === typeId)?.placeholder ?? typeId.toUpperCase()
}

const defaultPlaceholder = (id: string) => id.toUpperCase().replace(/[^A-Z0-9]/g, '_')

export function redact(
  text: string,
  findings: Finding[],
  decisions: Record<string, Decision>,
  numbering: Numbering,
  placeholder: (typeId: string) => string = defaultPlaceholder,
): { text: string; numbering: Numbering; count: number } {
  const next: Numbering = Object.fromEntries(Object.entries(numbering).map(([k, v]) => [k, { ...v }]))
  const sorted = [...findings]
    .filter(f => (decisions[f.typeId] ?? 'redact') === 'redact')
    .sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  let count = 0
  for (const f of sorted) {
    if (f.start < cursor) continue
    const byValue = (next[f.typeId] ??= {})
    const key = f.value.trim().toLowerCase()
    const n = byValue[key] ?? (byValue[key] = Object.keys(byValue).length + 1)
    out += text.slice(cursor, f.start) + `[${placeholder(f.typeId)}_${n}]`
    cursor = f.end
    count++
  }
  out += text.slice(cursor)
  return { text: out, numbering: next, count }
}

export function testPattern(source: string, samples: string[]):
  { ok: true; matches: { sample: string; found: string[] }[] } | { ok: false; reason: string } {
  const c = compilePattern(source)
  if (!c.ok) return c
  const matches = samples.map(sample => {
    const found: string[] = []
    c.regex.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = c.regex.exec(sample)) !== null) {
      if (m[0].length === 0) { c.regex.lastIndex++; continue }
      found.push(m[0])
    }
    return { sample, found }
  })
  return { ok: true, matches }
}
