import { test, expect } from 'claude-code/testing'
import type { Config } from '../types'
import { BUILTIN_TYPES, DEFAULT_ALLOWLIST } from './patterns'
import { scan } from './detect'
import { FIRST_NAMES } from './data/first-names'
import { SURNAMES } from './data/surnames'
import { CONDITIONS } from './data/conditions'
import { DRUGS } from './data/drugs'
import { COMMON_WORDS } from './data/common-words'

const config = (over: Partial<Config> = {}): Config => ({
  version: 1,
  types: BUILTIN_TYPES.map(t => ({ ...t })),
  watchlist: [],
  allowlist: [...DEFAULT_ALLOWLIST],
  scanToolReads: false,
  scrubLog: true,
  nameDictionary: true,
  ...over,
})

const tagged = (text: string, c = config()) => scan(text, 'prompt', c).map(f => `${f.typeId}:${f.value}:${f.confidence ?? 'high'}`)

test('the dictionaries hold what the tier relies on', async () => {
  expect(FIRST_NAMES).toContain('steven')
  expect(SURNAMES).toContain('jones')
  expect(CONDITIONS).toContain("crohn's disease")
  expect(DRUGS.some(d => d.startsWith('metformin'))).toBe(true)
  expect(COMMON_WORDS).toContain('payment')
})

test('a lowercase first name and surname is a high-confidence name', async () => {
  expect(tagged('steven jones, email stevie@yahoo.co.uk/ phone 07985 265489.')).toEqual([
    'name:steven jones:high', 'email:stevie@yahoo.co.uk:high', 'phone:07985 265489:high',
  ])
})

test('a first name before an uncommon word is a medium-confidence name; before a common word it is nothing', async () => {
  expect(tagged('ask steven zorblatt about it')).toEqual(['name:steven zorblatt:medium'])
  expect(tagged('the bill payment is due; will report back; mark done; art class')).toEqual([])
})

test('allowlist words and the dictionary toggle apply to dictionary names', async () => {
  expect(tagged('steven jones', config({ allowlist: ['jones'] }))).toEqual([])
  expect(tagged('steven jones', config({ nameDictionary: false }))).toEqual([])
})

test('conditions and drugs are health findings; medical suffixes are medium confidence', async () => {
  expect(tagged("she was told it is crohn's disease")).toEqual(["health:crohn's disease:high"])
  expect(tagged('taking metformin 500mg daily')).toEqual(['health:metformin:high'])
  expect(tagged('he has gastritis and a lipoma')).toEqual(['health:gastritis:medium', 'health:lipoma:medium'])
  expect(tagged('the aroma of coffee, a diploma, osmosis, the thesis')).toEqual([])
})
