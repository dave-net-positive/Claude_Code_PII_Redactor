import type { ToolSpec } from 'claude-code'
import type { Config, Locks } from '../types'
import { addCustomType, setEnabled, addTerm } from './config'
import { testPattern } from './detect'
import { emptyLocks, lockReason } from './policy'

export const TOOL_SPEC: ToolSpec = {
  name: 'pii_patterns',
  description: [
    'Manage pii-guard, the PII review gate. Actions: list (types with on/off, list sizes),',
    'test (run a regex or a saved type id against sample strings; returns which substrings matched per sample),',
    'add (save a custom regex type), watch (add a name to the watchlist), toggle with enabled=true (turn a type on).',
    'Anything that weakens the guard (turning a type off, removing a type, allowlisting, unwatching) is only available to the person through /pii.',
    'Before add: run test with 3+ positive and 3+ negative samples and show the user the result.',
    'Regexes get flags giu; nested quantifiers and patterns matching the empty string are rejected.',
    'Never put real PII values in samples; use fakes of the right shape.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'test', 'add', 'toggle', 'watch'] },
      id: { type: 'string', description: 'type id for add/remove/toggle/test (custom ids may omit the custom: prefix)' },
      label: { type: 'string', description: 'human label for add' },
      regex: { type: 'string', description: 'regex source for add or test' },
      placeholder: { type: 'string', description: 'redaction tag for add, e.g. REF -> [REF_1]' },
      samples: { type: 'array', items: { type: 'string' }, description: 'sample strings for test' },
      term: { type: 'string', description: 'name or term for watch' },
      enabled: { type: 'boolean', description: 'for toggle; only true is accepted' },
    },
    required: ['action'],
  },
  isDeferred: false,
}

export type ToolAnswer = { ok: boolean; message: string; data?: unknown }
export type ToolOutcome = { answer: ToolAnswer; config?: Config }

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/**
 * Pure: interprets one `pii_patterns` call. `config` is the person's stored
 * config, which edits apply to; `effective` (policy overlaid) is what `list`
 * and `test` read. The caller persists `config` when returned.
 */
export function runPatternsTool(config: Config, input: Record<string, unknown>, locks: Locks = emptyLocks(), effective: Config = config): ToolOutcome {
  const action = str(input.action)
  const fail = (message: string): ToolOutcome => ({ answer: { ok: false, message } })
  const saved = (c: Config, message: string, data?: unknown): ToolOutcome => ({ answer: { ok: true, message, data }, config: c })
  switch (action) {
    case 'list':
      return { answer: { ok: true, message: `${effective.types.length} types`, data: {
        types: effective.types.map(t => ({
          id: t.id, label: t.label, category: t.category, enabled: t.enabled, source: t.source,
          placeholder: t.placeholder, patterns: t.source === 'custom' ? t.patterns : undefined,
          policy: lockReason(locks, { kind: 'type', id: t.id }) ? true : undefined,
        })),
        // Counts only: the watchlist holds names, which are themselves personal data.
        watchlistCount: effective.watchlist.length, allowlistCount: effective.allowlist.length, scanToolReads: effective.scanToolReads,
      } } }
    case 'test': {
      const samples = Array.isArray(input.samples) ? input.samples.filter((s): s is string => typeof s === 'string') : []
      if (samples.length === 0) return fail('samples required')
      const id = str(input.id)
      const type = id ? effective.types.find(t => t.id === id || t.id === `custom:${id}`) : undefined
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
      const held = lockReason(locks, { kind: 'type', id })
      if (held) return fail(held)
      const r = addCustomType(config, { id, regex, label: str(input.label), placeholder: str(input.placeholder) })
      return r.ok ? saved(r.config, `added custom:${id.replace(/^custom:/, '')}, enabled`) : fail(r.reason)
    }
    case 'toggle': {
      if (input.enabled !== true) return fail('only enabled=true is accepted here; turning a type off is done by the person with /pii off <id>')
      const held = lockReason(locks, { kind: 'type', id: str(input.id) ?? '' })
      if (held) return fail(held)
      const r = setEnabled(config, str(input.id) ?? '', true)
      return r.ok ? saved(r.config, `${String(input.id)} enabled`) : fail(r.reason)
    }
    case 'watch': {
      const term = str(input.term)
      if (!term) return fail('term required')
      const c = addTerm(config, 'watchlist', term)
      return saved(c, `watchlist now has ${c.watchlist.length} entries`)
    }
    case 'remove': case 'unwatch': case 'allow': case 'unallow':
      return fail(`${action} weakens the guard and is only available to the person: use /pii ${action === 'remove' ? 'rm' : action} <...>`)
    default:
      return fail('unknown action; use list, test, add, toggle (enabled=true), watch')
  }
}
