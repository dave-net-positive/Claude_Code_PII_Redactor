export type Validator = 'luhn' | 'nhs' | 'iban' | 'none'

export type Category =
  | 'contact' | 'identity' | 'financial' | 'health' | 'secret' | 'network' | 'custom'

export type PiiType = {
  id: string
  label: string
  category: Category
  enabled: boolean
  source: 'builtin' | 'custom'
  patterns: string[]
  validator: Validator
  placeholder: string
  /** Compile patterns without the i flag (the name heuristic relies on case). */
  caseSensitive?: true
}

export type Config = {
  version: 1
  types: PiiType[]
  watchlist: string[]
  allowlist: string[]
  scanToolReads: boolean
}

export type Finding = {
  typeId: string
  value: string
  start: number
  end: number
  section: string
}

export type Decision = 'allow-once' | 'allow-session' | 'redact'

export type ReviewSection = { id: string; title: string; text: string; truncated?: true }

export type Unscannable = { filename?: string; type: string; mediaType?: string }

export type Review = {
  id: string
  kind: 'prompt' | 'tool'
  sections: ReviewSection[]
  findings: Finding[]
  unscannable: Unscannable[]
  decisions: Record<string, Decision>
  view: 'review' | 'settings'
}

declare module 'claude-code' {
  interface PluginState {
    'pii-guard': {
      review: Review | null
      sessionAllows: string[]
      settingsOpen: boolean
      configVersion: number
    }
  }
}
