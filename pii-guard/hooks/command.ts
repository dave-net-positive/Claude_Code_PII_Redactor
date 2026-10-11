import type { Config, Locks } from '../types'
import { addCustomType, removeType, setEnabled, addTerm, removeTerm } from './config'
import { scan, testPattern } from './detect'
import { emptyLocks, lockReason } from './policy'

export const USAGE = [
  'Usage:',
  '  /pii                      open settings',
  '  /pii list                 list types, watchlist and allowlist counts',
  '  /pii on <id> | off <id>   toggle a type',
  '  /pii add <id> <regex>     add a custom type (flags giu are applied)',
  '  /pii rm <id>              remove a custom type',
  '  /pii watch <term> | unwatch <term>',
  '  /pii allow <term> | unallow <term>',
  '  /pii test <id|regex> <sample text>',
  '  /pii reads on|off         scan Read tool results',
  '  /pii scrub on|off         star out redacted values in the local session log',
  '  /pii names on|off         dictionary matching of any-case first name + surname',
].join('\n')

export type CommandOutcome = {
  text?: string
  /** The config to persist, when the command changed it. */
  config?: Config
  openSettings?: true
}

/**
 * Pure: interprets `/pii <args>`. `config` is the person's own stored config,
 * which edits apply to; `effective` (with the policy overlaid) is what `list`
 * and `test` read. The caller persists `config` when returned.
 */
export function runPiiCommand(config: Config, args: string, locks: Locks = emptyLocks(), effective: Config = config): CommandOutcome {
  const trimmed = args.trim()
  if (!trimmed) return { openSettings: true }
  const [sub = '', ...rest] = trimmed.split(/\s+/)
  const restText = trimmed.slice(sub.length).trim()
  const changed = (c: Config, text: string): CommandOutcome => ({ config: c, text })
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 'es'}`
  const locked = (reason: string | null): CommandOutcome | null => (reason ? { text: `not changed: ${reason}` } : null)

  switch (sub) {
    case 'list': {
      const held = (id: string) => (lockReason(locks, { kind: 'type', id }) ? 'policy' : '')
      const rows = effective.types.map(t =>
        `  ${t.id.padEnd(22)} ${t.enabled ? 'on ' : 'off'} ${held(t.id).padEnd(7)}${t.label}${t.source === 'custom' ? `  /${t.patterns[0]}/` : ''}`)
      return { text: [
        'Types:', ...rows,
        `watchlist: ${effective.watchlist.length}${locks.watchlist.length ? ` (${locks.watchlist.length} from policy)` : ''}, `
        + `allowlist: ${effective.allowlist.length}${locks.allowlist.length ? ` (${locks.allowlist.length} from policy)` : ''}, `
        + `scan Read results: ${effective.scanToolReads ? 'on' : 'off'}${locks.scanToolReads ? ' (policy)' : ''}`,
      ].join('\n') }
    }
    case 'on': case 'off': {
      const id = rest[0] ?? ''
      const l = locked(lockReason(locks, { kind: 'type', id }))
      if (l) return l
      const r = setEnabled(config, id, sub === 'on')
      return r.ok ? changed(r.config, `${id} is now ${sub}`) : { text: r.reason }
    }
    case 'add': {
      const id = rest[0] ?? ''
      const regex = restText.slice(id.length).trim()
      if (!id || !regex) return { text: USAGE }
      const l = locked(lockReason(locks, { kind: 'type', id }))
      if (l) return l
      const r = addCustomType(config, { id, regex })
      return r.ok
        ? changed(r.config, `added custom:${id.replace(/^custom:/, '')} as /${regex}/giu, enabled`)
        : { text: `not added: ${r.reason}` }
    }
    case 'rm': {
      const id = rest[0] ?? ''
      const l = locked(lockReason(locks, { kind: 'type', id }))
      if (l) return l
      const r = removeType(config, id)
      return r.ok ? changed(r.config, `removed ${id}`) : { text: r.reason }
    }
    case 'watch': return changed(addTerm(config, 'watchlist', restText), `watching "${restText}"`)
    case 'unwatch': {
      const l = locked(lockReason(locks, { kind: 'watchlist', term: restText }))
      return l ?? changed(removeTerm(config, 'watchlist', restText), `no longer watching "${restText}"`)
    }
    case 'allow': {
      const l = locked(lockReason(locks, { kind: 'allowlist-add', term: restText }))
      return l ?? changed(addTerm(config, 'allowlist', restText), `"${restText.toLowerCase()}" will not be reported`)
    }
    case 'unallow': {
      const l = locked(lockReason(locks, { kind: 'allowlist', term: restText }))
      return l ?? changed(removeTerm(config, 'allowlist', restText), `"${restText.toLowerCase()}" removed from allowlist`)
    }
    case 'names': {
      if (rest[0] !== 'on' && rest[0] !== 'off') return { text: USAGE }
      return changed({ ...config, nameDictionary: rest[0] === 'on' }, `name dictionary: ${rest[0]}`)
    }
    case 'scrub': {
      if (rest[0] !== 'on' && rest[0] !== 'off') return { text: USAGE }
      return changed({ ...config, scrubLog: rest[0] === 'on' }, `local log scrub: ${rest[0]}`)
    }
    case 'reads': {
      if (rest[0] !== 'on' && rest[0] !== 'off') return { text: USAGE }
      const l = locked(lockReason(locks, { kind: 'scanToolReads' }))
      return l ?? changed({ ...config, scanToolReads: rest[0] === 'on' }, `scan Read results: ${rest[0]}`)
    }
    case 'test': {
      const target = rest[0] ?? ''
      const sample = restText.slice(target.length).trim()
      if (!target || !sample) return { text: USAGE }
      const type = effective.types.find(t => t.id === target || t.id === `custom:${target}`)
      if (type) {
        const found = scan(sample, 'test', { ...effective, allowlist: [], types: [{ ...type, enabled: true }] })
        return { text: `${plural(found.length, 'match')} for ${type.id}${found.length ? ': ' + found.map(f => f.value).join(', ') : ''}` }
      }
      const r = testPattern(target, [sample])
      if (!r.ok) return { text: `pattern rejected: ${r.reason}` }
      const found = r.matches[0]?.found ?? []
      return { text: `${plural(found.length, 'match')} for /${target}/giu${found.length ? ': ' + found.join(', ') : ''}` }
    }
    default: return { text: USAGE }
  }
}
