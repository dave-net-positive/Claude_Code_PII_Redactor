import type { ToolSpec } from 'claude-code'
import type { Config } from '../types'
import { addCustomType, removeType, setEnabled, addTerm, removeTerm } from './config'
import { testPattern } from './detect'

export const TOOL_SPEC: ToolSpec = {
  name: 'pii_patterns',
  description: [
    'Manage pii-guard, the PII review gate. Actions: list (types, watchlist, allowlist),',
    'test (run a regex or a saved type id against sample strings; returns which substrings matched per sample),',
    'add (save a custom regex type), remove (delete a custom type), toggle (enable/disable a type),',
    'watch/unwatch (names watchlist), allow/unallow (false-positive allowlist).',
    'Before add: run test with 3+ positive and 3+ negative samples and show the user the result.',
    'Regexes get flags giu; nested quantifiers and patterns matching the empty string are rejected.',
    'Never put real PII values in samples; use fakes of the right shape.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'test', 'add', 'remove', 'toggle', 'watch', 'unwatch', 'allow', 'unallow'] },
      id: { type: 'string', description: 'type id for add/remove/toggle/test (custom ids may omit the custom: prefix)' },
      label: { type: 'string', description: 'human label for add' },
      regex: { type: 'string', description: 'regex source for add or test' },
      placeholder: { type: 'string', description: 'redaction tag for add, e.g. REF -> [REF_1]' },
      samples: { type: 'array', items: { type: 'string' }, description: 'sample strings for test' },
      term: { type: 'string', description: 'term for watch/unwatch/allow/unallow' },
      enabled: { type: 'boolean', description: 'for toggle' },
    },
    required: ['action'],
  },
  isDeferred: false,
}

export type ToolAnswer = { ok: boolean; message: string; data?: unknown }
export type ToolOutcome = { answer: ToolAnswer; config?: Config }

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/** Pure: interprets one `pii_patterns` call against `config`; the caller persists `config` when returned. */
export function runPatternsTool(config: Config, input: Record<string, unknown>): ToolOutcome {
  const action = str(input.action)
  const fail = (message: string): ToolOutcome => ({ answer: { ok: false, message } })
  const saved = (c: Config, message: string, data?: unknown): ToolOutcome => ({ answer: { ok: true, message, data }, config: c })
  switch (action) {
    case 'list':
      return { answer: { ok: true, message: `${config.types.length} types`, data: {
        types: config.types.map(t => ({
          id: t.id, label: t.label, category: t.category, enabled: t.enabled, source: t.source,
          placeholder: t.placeholder, patterns: t.source === 'custom' ? t.patterns : undefined,
        })),
        watchlist: config.watchlist, allowlist: config.allowlist, scanToolReads: config.scanToolReads,
      } } }
    case 'test': {
      const samples = Array.isArray(input.samples) ? input.samples.filter((s): s is string => typeof s === 'string') : []
      if (samples.length === 0) return fail('samples required')
      const id = str(input.id)
      const type = id ? config.types.find(t => t.id === id || t.id === `custom:${id}`) : undefined
      const regex = str(input.regex)
      const sources = type ? type.patterns : regex ? [regex] : []
      if (sources.length === 0) return fail('give regex or a known id')
      const merged = samples.map(sample => ({ sample, found: [] as string[] }))
      for (const src of sources) {
        const r = testPattern(src, samples)
        if (!r.ok) return fail(`pattern rejected: ${r.reason}`)
        r.matches.forEach((m, i) => merged[i]!.found.push(...m.found))
      }
      return { answer: { ok: true, message: `${merged.filter(m => m.found.length).length} of ${samples.length} samples matched`, data: merged } }
    }
    case 'add': {
      const id = str(input.id)
      const regex = str(input.regex)
      if (!id || !regex) return fail('id and regex required')
      const r = addCustomType(config, { id, regex, label: str(input.label), placeholder: str(input.placeholder) })
      return r.ok ? saved(r.config, `added custom:${id.replace(/^custom:/, '')}, enabled`) : fail(r.reason)
    }
    case 'remove': {
      const r = removeType(config, str(input.id) ?? '')
      return r.ok ? saved(r.config, `removed ${String(input.id)}`) : fail(r.reason)
    }
    case 'toggle': {
      if (typeof input.enabled !== 'boolean') return fail('enabled (boolean) required')
      const r = setEnabled(config, str(input.id) ?? '', input.enabled)
      return r.ok ? saved(r.config, `${String(input.id)} ${input.enabled ? 'enabled' : 'disabled'}`) : fail(r.reason)
    }
    case 'watch': case 'unwatch': case 'allow': case 'unallow': {
      const term = str(input.term)
      if (!term) return fail('term required')
      const list = action.endsWith('watch') ? 'watchlist' : 'allowlist'
      const c = action.startsWith('un') ? removeTerm(config, list, term) : addTerm(config, list, term)
      return saved(c, `${action}: ${list} now has ${c[list].length} entries`)
    }
    default:
      return fail('unknown action; use list, test, add, remove, toggle, watch, unwatch, allow, unallow')
  }
}
