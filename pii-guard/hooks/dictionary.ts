/**
 * Dictionary tier: names and health terms that no shape or cue reveals.
 * Pure. Word lists come from tools/build-dictionaries.py (public-domain sources).
 */
import type { Finding } from '../types'
import { FIRST_NAMES } from './data/first-names'
import { SURNAMES } from './data/surnames'
import { COMMON_WORDS } from './data/common-words'
import { CONDITIONS } from './data/conditions'
import { DRUGS } from './data/drugs'

const FIRST = new Set(FIRST_NAMES)
const SUR = new Set(SURNAMES)
const COMMON = new Set(COMMON_WORDS)

const TOKEN = /[\p{L}][\p{L}'’-]*/gu

type Hit = { value: string; start: number; end: number; confidence: 'high' | 'medium' }

/**
 * `first surname` in any case: a listed first name followed, across whitespace
 * only, by a listed surname (high) or by a word that is neither common English
 * nor a stopword (medium). Single names are never reported alone.
 */
export function dictionaryNames(text: string, stopwords: ReadonlySet<string>): Hit[] {
  const tokens: { word: string; start: number; end: number }[] = []
  for (const m of text.matchAll(TOKEN)) tokens.push({ word: m[0], start: m.index!, end: m.index! + m[0].length })
  const out: Hit[] = []
  for (let i = 0; i + 1 < tokens.length; i++) {
    const a = tokens[i]!, b = tokens[i + 1]!
    const first = a.word.toLowerCase()
    if (!FIRST.has(first)) continue
    const between = text.slice(a.end, b.start)
    if (!/^[ \t]+$/.test(between)) continue
    const second = b.word.toLowerCase().replace(/[’]/g, "'")
    if (second.length < 2 || stopwords.has(second) || FIRST.has(second) && COMMON.has(second)) continue
    if (SUR.has(second)) {
      out.push({ value: text.slice(a.start, b.end), start: a.start, end: b.end, confidence: 'high' })
      i++
    } else if (!COMMON.has(second) && /^[\p{L}][\p{L}'-]+$/u.test(second)) {
      out.push({ value: text.slice(a.start, b.end), start: a.start, end: b.end, confidence: 'medium' })
      i++
    }
  }
  return out
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function phraseRegex(words: readonly string[]): RegExp {
  const sorted = [...new Set(words)].filter(w => w.length >= 4).sort((a, b) => b.length - a.length)
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${sorted.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'giu')
}

let conditionRe: RegExp | null = null
let drugRe: RegExp | null = null

/** Medical word shapes; medium confidence. */
const SUFFIX_RE = /\b[a-z]{3,}(?:itis|osis|aemia|emia|pathy|algia|ectomy|plasty|oscopy|rrhoea|rrhea)\b|\b[a-z]{3,}oma\b/giu
const SUFFIX_EXCLUDE = new Set([
  'diagnosis', 'prognosis', 'hypnosis', 'osmosis', 'symbiosis', 'metamorphosis', 'apotheosis', 'thesis',
  'synthesis', 'hypothesis', 'parenthesis', 'emphasis', 'basis', 'oasis', 'crisis', 'analysis', 'paralysis',
  'aroma', 'diploma', 'cinema', 'panorama', 'drama', 'melodrama', 'dogma', 'enigma', 'stigma', 'schema',
  'charisma', 'dilemma', 'karma', 'llama', 'puma', 'mama', 'firma', 'roma', 'sonoma', 'tacoma', 'oklahoma',
  'sympathy', 'empathy', 'apathy', 'telepathy', 'homeopathy', 'osteopathy', 'antipathy', 'nostalgia',
  'kinematics', 'plasty', 'gnosis', 'prognostic', 'cosmosis', 'aroma', 'genoma', 'glioma',
])

/** Listed conditions and drugs (high), medical suffixes (medium). */
export function dictionaryHealth(text: string): Hit[] {
  conditionRe ??= phraseRegex(CONDITIONS)
  drugRe ??= phraseRegex(DRUGS)
  const out: Hit[] = []
  for (const re of [conditionRe, drugRe]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue }
      out.push({ value: m[0], start: m.index, end: m.index + m[0].length, confidence: 'high' })
    }
  }
  SUFFIX_RE.lastIndex = 0
  let s: RegExpExecArray | null
  while ((s = SUFFIX_RE.exec(text)) !== null) {
    if (SUFFIX_EXCLUDE.has(s[0].toLowerCase())) continue
    out.push({ value: s[0], start: s.index, end: s.index + s[0].length, confidence: 'medium' })
  }
  return out
}

export const toFindings = (hits: Hit[], typeId: string, section: string): Finding[] =>
  hits.map(h => ({ typeId, value: h.value, start: h.start, end: h.end, section, confidence: h.confidence }))
