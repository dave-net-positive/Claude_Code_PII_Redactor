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
  /** Patch the typed text out of the local session log after a redaction (default true). */
  scrubLog: boolean
  /** Catch any-case names from the first-name and surname dictionaries (default true). */
  nameDictionary: boolean
}

/** An organisation's policy file, parsed. Every list may be empty. */
export type Policy = {
  watchlist: string[]
  /** Lower-cased. */
  allowlist: string[]
  types: Record<string, { enabled: boolean }>
  customTypes: PiiType[]
  scanToolReads?: boolean
}

/** What a policy holds, so the pane, /pii and the tool refuse to change it. Terms lower-cased. */
export type Locks = {
  watchlist: string[]
  allowlist: string[]
  /** Type ids whose enabled state, or existence (policy custom types), is held. */
  types: string[]
  scanToolReads: boolean
}

/** How the policy file stands, for the settings view. */
export type PolicyStatus = {
  path: string
  loadedAt: number | null
  error: string | null
  warnings: string[]
}

export type Finding = {
  typeId: string
  value: string
  start: number
  end: number
  section: string
  /** Absent means high: a checksum, a pattern or a dictionary phrase. Medium is a shape or a guess. */
  confidence?: 'high' | 'medium'
}

export type Decision = 'allow-once' | 'allow-session' | 'redact'

export type ReviewSection = { id: string; title: string; text: string; truncated?: true }

export type Unscannable = { filename?: string; type: string; mediaType?: string }

export type Review = {
  id: string
  kind: 'prompt' | 'tool'
  /** The prompt as typed, resubmitted (redacted) on Send. Empty for a tool review. */
  original: string
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
      /** Prompts held behind the one shown, oldest first. */
      queue: Review[]
      sessionAllows: string[]
      settingsOpen: boolean
      configVersion: number
    }
  }
}
