import type { Config, Locks, PiiType, Policy } from '../types'
import { compilePattern } from './detect'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(s => s.trim()).filter(Boolean) : []

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

export function emptyLocks(): Locks {
  return { watchlist: [], allowlist: [], types: [], scanToolReads: false }
}

/** Reads a policy document as an administrator wrote it; unknown keys are ignored, bad entries reported. */
export function parsePolicy(raw: unknown): { policy: Policy; errors: string[] } {
  const errors: string[] = []
  const policy: Policy = { watchlist: [], allowlist: [], types: {}, customTypes: [] }
  if (raw === undefined || raw === null) return { policy, errors }
  if (!isRecord(raw)) return { policy, errors: ['policy file is not a JSON object'] }

  policy.watchlist = strings(raw.watchlist)
  policy.allowlist = strings(raw.allowlist).map(s => s.toLowerCase())
  if (typeof raw.scanToolReads === 'boolean') policy.scanToolReads = raw.scanToolReads

  if (isRecord(raw.types)) {
    for (const [id, v] of Object.entries(raw.types)) {
      if (isRecord(v) && typeof v.enabled === 'boolean') policy.types[id] = { enabled: v.enabled }
      else errors.push(`types.${id}: expected { "enabled": true|false }`)
    }
  }

  if (Array.isArray(raw.customTypes)) {
    raw.customTypes.forEach((entry, i) => {
      if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.regex !== 'string') {
        errors.push(`customTypes[${i}]: needs id and regex`)
        return
      }
      const bare = entry.id.trim().toLowerCase().replace(/^custom:/, '')
      if (!ID_RE.test(bare)) { errors.push(`customTypes[${i}]: id must be 1-32 of a-z, 0-9, _ or -`); return }
      const c = compilePattern(entry.regex)
      if (!c.ok) { errors.push(`customTypes[${i}] (${bare}): ${c.reason}`); return }
      const placeholder = (typeof entry.placeholder === 'string' ? entry.placeholder : bare).toUpperCase().replace(/[^A-Z0-9]/g, '_')
      const type: PiiType = {
        id: `custom:${bare}`,
        label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : bare,
        category: 'custom', enabled: true, source: 'custom',
        patterns: [entry.regex], validator: 'none', placeholder,
      }
      policy.customTypes.push(type)
    })
  }
  return { policy, errors }
}

/**
 * Overlays `policy` on the user's stored config. The user's config is not
 * changed; the result is what scanning and the pane use, with `locks` naming
 * what the person may not change.
 */
export function applyPolicy(user: Config, policy: Policy): { config: Config; locks: Locks } {
  const lower = (s: string) => s.trim().toLowerCase()
  const locks: Locks = {
    watchlist: policy.watchlist.map(lower),
    allowlist: policy.allowlist.map(lower),
    types: [...Object.keys(policy.types), ...policy.customTypes.map(t => t.id)],
    scanToolReads: policy.scanToolReads !== undefined,
  }
  const have = (list: string[], term: string) => list.some(x => lower(x) === lower(term))
  const watchlist = [...user.watchlist, ...policy.watchlist.filter(t => !have(user.watchlist, t))]
  const allowlist = [...user.allowlist, ...policy.allowlist.filter(t => !have(user.allowlist, t))]
  const types = user.types
    .filter(t => !policy.customTypes.some(p => p.id === t.id))
    .map(t => (t.id in policy.types ? { ...t, enabled: policy.types[t.id]!.enabled } : t))
  const config: Config = {
    ...user,
    watchlist,
    allowlist,
    types: [...types, ...policy.customTypes],
    scanToolReads: policy.scanToolReads ?? user.scanToolReads,
  }
  return { config, locks }
}

export type LockedChange =
  | { kind: 'type'; id: string }
  | { kind: 'watchlist'; term: string }
  | { kind: 'allowlist'; term: string }
  | { kind: 'scanToolReads' }

/** Why a change is refused under `locks`, or null when the person may make it. */
export function lockReason(locks: Locks, change: LockedChange): string | null {
  const lower = (s: string) => s.trim().toLowerCase()
  switch (change.kind) {
    case 'type': {
      const id = change.id.startsWith('custom:') ? change.id : change.id
      const held = locks.types.includes(id) || locks.types.includes(`custom:${id}`)
      return held ? `${change.id} is set by your organisation's policy` : null
    }
    case 'watchlist':
      return locks.watchlist.includes(lower(change.term)) ? `"${change.term}" is on the policy watchlist` : null
    case 'allowlist':
      return locks.allowlist.includes(lower(change.term)) ? `"${change.term}" is on the policy allowlist` : null
    case 'scanToolReads':
      return locks.scanToolReads ? 'Read scanning is set by your organisation\'s policy' : null
  }
}
