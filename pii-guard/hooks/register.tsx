import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'
import type { Config, Decision, Review } from '../types'
import {
  STORE_KEY, mergeBuiltins, setEnabled,
  removeType as removeTypeFrom, addTerm as addTermTo, removeTerm as removeTermFrom,
} from './config'
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

function actionsFor($: EngineInterface): PaneActions {
  const edit = async (fn: (c: Config) => Config) => saveConfig($, fn(await loadConfig($)))
  return {
    decide: (typeId, d: Decision) => void update($, reviewAtom, r => r ? { ...r, decisions: { ...r.decisions, [typeId]: d } } : r),
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
  on('session.start', async ($, e, next) => next(e))

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
