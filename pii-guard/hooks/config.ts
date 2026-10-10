import type { Config, PiiType } from '../types'
import { BUILTIN_TYPES, DEFAULT_ALLOWLIST } from './patterns'
import { compilePattern } from './detect'

export const STORE_KEY = 'config'

export function defaultConfig(): Config {
  return {
    version: 1,
    types: BUILTIN_TYPES.map(t => ({ ...t, patterns: [...t.patterns] })),
    watchlist: [],
    allowlist: [...DEFAULT_ALLOWLIST],
    scanToolReads: false,
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

function asCustomType(v: Record<string, unknown>): PiiType | null {
  if (typeof v.id !== 'string' || !Array.isArray(v.patterns) || typeof v.placeholder !== 'string') return null
  const patterns = strings(v.patterns)
  if (patterns.length === 0) return null
  return {
    id: v.id,
    label: typeof v.label === 'string' ? v.label : v.id,
    category: 'custom',
    enabled: v.enabled !== false,
    source: 'custom',
    patterns,
    validator: 'none',
    placeholder: v.placeholder,
  }
}

export function mergeBuiltins(stored: unknown): Config {
  const base = defaultConfig()
  if (!isRecord(stored)) return base
  const storedTypes = Array.isArray(stored.types) ? stored.types : []
  const enabledById = new Map<string, boolean>()
  const custom: PiiType[] = []
  for (const t of storedTypes) {
    if (!isRecord(t) || typeof t.id !== 'string') continue
    if (t.source === 'custom') {
      const c = asCustomType(t)
      if (c) custom.push(c)
    } else if (typeof t.enabled === 'boolean') {
      enabledById.set(t.id, t.enabled)
    }
  }
  return {
    version: 1,
    types: [
      ...base.types.map(t => ({ ...t, enabled: enabledById.get(t.id) ?? true })),
      ...custom,
    ],
    watchlist: strings(stored.watchlist),
    allowlist: 'allowlist' in stored ? strings(stored.allowlist) : base.allowlist,
    scanToolReads: stored.scanToolReads === true,
  }
}

type Outcome = { ok: true; config: Config } | { ok: false; reason: string }

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

export function addCustomType(config: Config, args: { id: string; label?: string; regex: string; placeholder?: string }): Outcome {
  const bare = (args.id ?? '').trim().toLowerCase().replace(/^custom:/, '')
  if (!ID_RE.test(bare)) return { ok: false, reason: 'id must be 1-32 of a-z, 0-9, _ or -' }
  const id = `custom:${bare}`
  if (config.types.some(t => t.id === id || t.id === bare)) return { ok: false, reason: `a type with id ${id} already exists` }
  const c = compilePattern(args.regex)
  if (!c.ok) return { ok: false, reason: c.reason }
  const placeholder = (args.placeholder ?? bare).toUpperCase().replace(/[^A-Z0-9]/g, '_')
  const type: PiiType = {
    id, label: args.label?.trim() || bare, category: 'custom', enabled: true, source: 'custom',
    patterns: [args.regex], validator: 'none', placeholder,
  }
  return { ok: true, config: { ...config, types: [...config.types, type] } }
}

export function removeType(config: Config, id: string): Outcome {
  const full = id.startsWith('custom:') ? id : `custom:${id}`
  const t = config.types.find(t => t.id === full)
  if (!t) {
    if (config.types.some(t => t.id === id)) return { ok: false, reason: 'built-in types cannot be removed, turn them off instead' }
    return { ok: false, reason: `no custom type ${full}` }
  }
  if (t.source !== 'custom') return { ok: false, reason: 'built-in types cannot be removed, turn them off instead' }
  return { ok: true, config: { ...config, types: config.types.filter(x => x.id !== full) } }
}

export function setEnabled(config: Config, id: string, enabled: boolean): Outcome {
  const match = config.types.find(t => t.id === id || t.id === `custom:${id}`)
  if (!match) return { ok: false, reason: `no type ${id}` }
  return { ok: true, config: { ...config, types: config.types.map(t => t.id === match.id ? { ...t, enabled } : t) } }
}

export function addTerm(config: Config, list: 'watchlist' | 'allowlist', term: string): Config {
  const t = term.trim()
  if (!t) return config
  const lower = t.toLowerCase()
  if (config[list].some(x => x.toLowerCase() === lower)) return config
  return { ...config, [list]: [...config[list], list === 'allowlist' ? lower : t] }
}

export function removeTerm(config: Config, list: 'watchlist' | 'allowlist', term: string): Config {
  const lower = term.trim().toLowerCase()
  return { ...config, [list]: config[list].filter(x => x.toLowerCase() !== lower) }
}
