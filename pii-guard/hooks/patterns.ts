import type { Category, PiiType, Validator } from '../types'

const digits = (s: string) => s.replace(/\D/g, '')

function luhn(value: string): boolean {
  const d = digits(value)
  if (d.length < 13 || d.length > 19) return false
  let sum = 0
  let dbl = false
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i])
    if (dbl) { n *= 2; if (n > 9) n -= 9 }
    sum += n
    dbl = !dbl
  }
  return sum % 10 === 0
}

function nhs(value: string): boolean {
  const d = digits(value)
  if (d.length !== 10) return false
  let sum = 0
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * (10 - i)
  let check = 11 - (sum % 11)
  if (check === 11) check = 0
  if (check === 10) return false
  return check === Number(d[9])
}

function iban(value: string): boolean {
  const s = value.replace(/\s+/g, '').toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false
  const rearranged = s.slice(4) + s.slice(0, 4)
  const numeric = rearranged.replace(/[A-Z]/g, ch => String(ch.charCodeAt(0) - 55))
  let remainder = 0
  for (const ch of numeric) remainder = (remainder * 10 + Number(ch)) % 97
  return remainder === 1
}

export const VALIDATORS: Record<Validator, (value: string) => boolean> = {
  luhn, nhs, iban, none: () => true,
}

export const CATEGORY_COLOR: Record<Category, string> = {
  secret: 'error',
  financial: 'warning',
  health: 'error',
  identity: 'warning',
  contact: 'suggestion',
  network: 'subtle',
  custom: 'claude',
}

const t = (
  id: string, label: string, category: Category, placeholder: string,
  patterns: string[], validator: Validator = 'none',
): PiiType => ({ id, label, category, enabled: true, source: 'builtin', patterns, validator, placeholder })

export const BUILTIN_TYPES: PiiType[] = [
  t('email', 'Email address', 'contact', 'EMAIL',
    [String.raw`\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`]),
  t('phone', 'Phone number', 'contact', 'PHONE', [
    String.raw`(?<!\w)(?:\+44\s?7\d{3}|\(?07\d{3}\)?)\s?\d{3}\s?\d{3}(?!\w)`,
    String.raw`(?<!\w)(?:\+44\s?[1-3]\d{2,3}|\(?0[1-3]\d{2,3}\)?)\s?\d{3}\s?\d{3,4}(?!\w)`,
    String.raw`(?<!\w)\+(?!44)\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}(?!\w)`,
  ]),
  t('postcode', 'UK postcode', 'contact', 'POSTCODE',
    [String.raw`\b(?:GIR ?0AA|[A-PR-UWYZ](?:\d{1,2}|[A-HK-Y]\d{1,2}|\d[A-HJKPSTUW]|[A-HK-Y]\d[ABEHMNPRVWXY]) ?\d[ABD-HJLNP-UW-Z]{2})\b`]),
  t('ni-number', 'UK National Insurance number', 'identity', 'NINO',
    [String.raw`\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b`]),
  t('nhs-number', 'NHS number', 'health', 'NHS',
    [String.raw`\b\d{3} ?\d{3} ?\d{4}\b`], 'nhs'),
  t('passport', 'Passport number', 'identity', 'PASSPORT',
    [String.raw`(?<=passport(?:\s+(?:no|number|#))?[:\s]{1,5}[^\n]{0,30}?)\b\d{9}\b`]),
  t('driving-licence', 'UK driving licence', 'identity', 'LICENCE',
    [String.raw`\b[A-Z9]{5}\d{6}[A-Z9]{2}\d[A-Z]{2}\b`]),
  t('card', 'Payment card number', 'financial', 'CARD',
    [String.raw`\b(?:\d[ -]?){12,18}\d\b`], 'luhn'),
  t('iban', 'IBAN', 'financial', 'IBAN',
    [String.raw`\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b`], 'iban'),
  t('sort-account', 'UK sort code and account number', 'financial', 'BANKACCT',
    [String.raw`\b\d{2}-\d{2}-\d{2}\b[^\n]{0,20}?\b\d{8}\b`]),
  t('ssn', 'US Social Security number', 'identity', 'SSN',
    [String.raw`\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b`]),
  t('ip', 'IP address', 'network', 'IP', [
    String.raw`\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b`,
    String.raw`(?<![:\w])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![:\w])`,
  ]),
  t('dob', 'Date of birth', 'identity', 'DOB',
    [String.raw`(?<=(?:dob|date of birth|born)[^\n]{0,30}?)\b(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{2,4})\b`]),
  t('secret', 'API key or secret', 'secret', 'SECRET', [
    String.raw`\bAKIA[0-9A-Z]{16}\b`,
    String.raw`\bgh[pousr]_[A-Za-z0-9]{36,}\b`,
    String.raw`\bxox[baprs]-[A-Za-z0-9-]{10,}\b`,
    String.raw`\bsk-ant-[A-Za-z0-9_-]{20,}\b`,
    String.raw`\bsk-[A-Za-z0-9]{20,}\b`,
    String.raw`\bAIza[0-9A-Za-z_-]{35}\b`,
    String.raw`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`,
    String.raw`-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----`,
    String.raw`(?<=\b(?:api[_-]?key|secret|token|password|passwd|pwd)\b["']?\s*[:=]\s*["']?)[^\s"']{8,}`,
  ]),
  t('health', 'Health terms', 'health', 'HEALTH', [
    String.raw`\b(?:diagnos(?:is|ed|es)|prescri(?:ption|bed)|medication|chemotherapy|psychiatric|HIV|hepatitis|diabet(?:es|ic)|epilep(?:sy|tic)|schizophreni[ac]|bipolar|dementia|cancer)\b`,
    String.raw`(?<=\bICD(?:-10)?[:\s]{1,3})[A-Z]\d{2}(?:\.\d{1,2})?\b`,
  ]),
  { ...t('name', 'Personal name', 'identity', 'NAME', [
    String.raw`\b(?:Mr|Mrs|Ms|Miss|Dr|Prof|Sir|Dame)\.? [A-Z][a-z]+(?: [A-Z][a-z]+)?\b`,
    String.raw`(?<![.!?]\s)(?<!^)\b[A-Z][a-z]{1,}(?:[-'][A-Z][a-z]+)? [A-Z][a-z]{1,}\b`,
    // Any case, when a person is introduced: "my name is garry bellows". Exactly two words
    // of two or more letters, so "my name is a secret" misses; detect.ts drops stopwords.
    String.raw`(?i)(?<=\b(?:my|his|her|their|the customer's|the client's|the patient's) name(?: is|'s)\s+|\bi(?:'m| am) called\s+|\byou can call me\s+|\bcall me\s+)[a-z][a-z'’-]+\s+[a-z][a-z'’-]+\b`,
  ]), caseSensitive: true },
]

/**
 * Never reported. A single word here also suppresses any heuristic name pair
 * that contains it (so `microsoft` covers Microsoft Teams); pairs are for the
 * few cases with no safe single word.
 */
export const DEFAULT_ALLOWLIST: string[] = [
  // vendors and products
  'microsoft', 'google', 'amazon', 'apple', 'meta', 'anthropic', 'claude', 'openai', 'cloudflare',
  'github', 'gitlab', 'bitbucket', 'azure', 'aws', 'docker', 'kubernetes', 'linux', 'windows', 'ubuntu',
  'python', 'typescript', 'javascript', 'node', 'react', 'angular', 'vue', 'svelte', 'django', 'flask',
  'spring', 'rails', 'postgres', 'postgresql', 'mysql', 'mongodb', 'redis', 'neo4j', 'sqlite',
  'visual', 'studio', 'code', 'teams', 'slack', 'discord', 'zoom', 'notion', 'jira', 'confluence',
  'copilot', 'gemini', 'chatgpt', 'ollama', 'hugging', 'face', 'power', 'apps', 'automate', 'fabric',
  'sharepoint', 'onedrive', 'outlook', 'excel', 'word', 'powerpoint', 'dynamics', 'intune', 'entra',
  'terraform', 'ansible', 'jenkins', 'actions', 'workers', 'pages', 'lambda', 'vercel', 'netlify',
  // programming words that get capitalised in prose
  'pull', 'request', 'stack', 'overflow', 'machine', 'learning', 'open', 'source', 'api', 'sdk',
  'cloud', 'server', 'client', 'service', 'platform', 'enterprise', 'premium', 'standard', 'basic',
  // places
  'new', 'york', 'united', 'kingdom', 'states', 'hong', 'kong', 'los', 'angeles', 'san', 'francisco',
  'north', 'south', 'east', 'west', 'america', 'zealand', 'africa', 'europe', 'asia', 'london',
  'manchester', 'birmingham', 'edinburgh', 'cardiff', 'belfast', 'dublin',
  // calendar and common capitalised words
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october',
  'november', 'december',
  // the author's own projects
  'uk biobank', 'net positive', 'dyson sphere',
].map(s => s.toLowerCase())
