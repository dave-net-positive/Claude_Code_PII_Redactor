import type { Config } from '../types'
import { addCustomType, removeType, setEnabled, addTerm, removeTerm } from './config'
import { scan, testPattern } from './detect'

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
].join('\n')

export type CommandOutcome = {
  text?: string
  /** The config to persist, when the command changed it. */
  config?: Config
  openSettings?: true
}

/** Pure: interprets `/pii <args>` against `config`; the caller persists `config` when returned. */
export function runPiiCommand(config: Config, args: string): CommandOutcome {
  const trimmed = args.trim()
  if (!trimmed) return { openSettings: true }
  const [sub = '', ...rest] = trimmed.split(/\s+/)
  const restText = trimmed.slice(sub.length).trim()
  const changed = (c: Config, text: string): CommandOutcome => ({ config: c, text })
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 'es'}`

  switch (sub) {
    case 'list': {
      const rows = config.types.map(t =>
        `  ${t.id.padEnd(22)} ${t.enabled ? 'on ' : 'off'}  ${t.label}${t.source === 'custom' ? `  /${t.patterns[0]}/` : ''}`)
      return { text: [
        'Types:', ...rows,
        `watchlist: ${config.watchlist.length}, allowlist: ${config.allowlist.length}, scan Read results: ${config.scanToolReads ? 'on' : 'off'}`,
      ].join('\n') }
    }
    case 'on': case 'off': {
      const r = setEnabled(config, rest[0] ?? '', sub === 'on')
      return r.ok ? changed(r.config, `${rest[0]} is now ${sub}`) : { text: r.reason }
    }
    case 'add': {
      const id = rest[0] ?? ''
      const regex = restText.slice(id.length).trim()
      if (!id || !regex) return { text: USAGE }
      const r = addCustomType(config, { id, regex })
      return r.ok
        ? changed(r.config, `added custom:${id.replace(/^custom:/, '')} as /${regex}/giu, enabled`)
        : { text: `not added: ${r.reason}` }
    }
    case 'rm': {
      const r = removeType(config, rest[0] ?? '')
      return r.ok ? changed(r.config, `removed ${rest[0]}`) : { text: r.reason }
    }
    case 'watch': return changed(addTerm(config, 'watchlist', restText), `watching "${restText}"`)
    case 'unwatch': return changed(removeTerm(config, 'watchlist', restText), `no longer watching "${restText}"`)
    case 'allow': return changed(addTerm(config, 'allowlist', restText), `"${restText.toLowerCase()}" will not be reported`)
    case 'unallow': return changed(removeTerm(config, 'allowlist', restText), `"${restText.toLowerCase()}" removed from allowlist`)
    case 'reads': {
      if (rest[0] !== 'on' && rest[0] !== 'off') return { text: USAGE }
      return changed({ ...config, scanToolReads: rest[0] === 'on' }, `scan Read results: ${rest[0]}`)
    }
    case 'test': {
      const target = rest[0] ?? ''
      const sample = restText.slice(target.length).trim()
      if (!target || !sample) return { text: USAGE }
      const type = config.types.find(t => t.id === target || t.id === `custom:${target}`)
      if (type) {
        const found = scan(sample, 'test', { ...config, allowlist: [], types: [{ ...type, enabled: true }] })
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
