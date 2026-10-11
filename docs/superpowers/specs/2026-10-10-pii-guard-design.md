# pii-guard: PII review gate for Claude Code prompts

Date: 2026-10-10
Status: approved design, v1

## Purpose

A Claude Code mod that scans what the user is about to send to the model for
personally identifiable information (PII) and secrets, stops the prompt before
it enters the session when any is found, and shows a review pane where the user
decides per PII type whether to allow it, allow it for the rest of the session,
or redact it. The user can cancel the prompt outright. Detection is code-driven
(regex plus validators), configurable per type, and extensible with
user-defined patterns that Claude can help author through a tool.

## Scope

### In scope (v1)

- Scan the main prompt text as typed, with pastes expanded.
- Scan the contents of files pulled in by `@path` mentions, shown in the same
  review as the prompt.
- Optionally (off by default) scan the result of the `Read` tool and gate it
  mid-turn through the same pane.
- Flag images, PDFs and audio attachments as unscannable and ask Send or
  Cancel for the prompt that carries them.
- Per-type toggles, a names watchlist, a false-positive allowlist, custom regex
  types; all persisted in the mod's store across sessions.
- A `/pii` slash command and a model-callable `pii_patterns` tool for managing
  configuration.

### Out of scope (v1), tracked for v2

- Scanning subagent prompts (`agentId` present on the chain).
- Scanning `Bash` and `Grep` tool output.
- Per-project (per working directory) pattern sets and remembered decisions.
- Image, PDF and audio content scanning (would need OCR or a model call, and a
  model call would itself send the PII).

## Platform facts the design relies on

From the mod API types shipped with this build:

- `prompt.submit` hook receives `e.text` (pastes expanded), optional
  `e.attachments` (kind, MIME type and filename only, never bytes), and
  `e.origin`. The hook may call `next({ ...e, text })` to rewrite, or return
  `{ drop: reason }` without `next` to refuse.
- `@path` mentions raise `prompt.mention` and then `prompt.attachment` per
  file; the attachment hook may rewrite the text the model reads.
- `tool.call` hooks may `await next(e)` and return their own `{ result }` or
  `{ deny }` in place of the tool's.
- A pane is opened with `$.ui.open({ id, title, focus, closeOnEscape,
  holdToasts, rows })` and drawn by a `ui.render` hook on
  `{ component: 'Pane', requestId: id }`. A pane opened in answer to a
  submitted prompt is placed at any terminal width.
- Elements available on terminal, desktop and vscode: `Box`, `Text` (with
  `color`, `backgroundColor`, `inverse`, `bold`, `dimColor`), `Button` (with
  `hotkey`), `Input`, `Select`, `Code`, `Markdown`. Mobile lacks `Input` and
  `Select`.
- `$.store` is a per-plugin JSON key-value store kept across sessions.
  `$.state` holds session values that survive hot reload and drive redraws.
- `$.ui.ask` rejects in a `claude -p` run: there is nobody to ask.

## Files

```
<repo>/pii-guard/
  .claude-plugin/plugin.json      name, version, description, "types": "./types/index.d.ts"
  hooks/hooks.json                { "modules": ["./register.tsx"] }
  hooks/register.tsx              event wiring only
  hooks/detect.ts                 pure scanner and redactor, no `$` access
  hooks/patterns.ts               built-in PII type definitions and default allowlist
  hooks/config.ts                 load, merge and save config via $.store
  hooks/review.tsx                pane drawing: review view and settings view
  hooks/detect.test.ts            scanner unit tests
  hooks/review.test.ts            end-to-end tests through the engine test kit
  types/index.d.ts                PluginState contract and shared types
  README.md                       install, usage, how to add a pattern
```

`detect.ts` and `patterns.ts` import nothing from `claude-code` so they can be
reasoned about and tested in isolation.

## Data model

```ts
type Validator = 'luhn' | 'nhs' | 'iban' | 'none'

type PiiType = {
  id: string            // 'email', 'card', 'custom:nhs-ref'
  label: string         // 'Email address'
  category: 'contact' | 'identity' | 'financial' | 'health' | 'secret' | 'network' | 'custom'
  enabled: boolean
  source: 'builtin' | 'custom'
  patterns: string[]    // regex sources; compiled with flags 'giu'
  validator: Validator  // post-match check that drops false positives
  placeholder: string   // 'EMAIL' -> [EMAIL_1]
}

type Config = {
  version: 1
  types: PiiType[]
  watchlist: string[]       // names and terms matched whole-word, case-insensitive
  allowlist: string[]       // values never reported, any type
  scanToolReads: boolean    // default false
}

type Finding = {
  typeId: string
  value: string
  start: number
  end: number
  section: string           // 'prompt' | 'file:<abs path>' | 'tool:<tool_use_id>'
}

type Decision = 'allow-once' | 'allow-session' | 'redact'

type Review = {
  id: string
  kind: 'prompt' | 'tool'
  sections: { id: string; title: string; text: string }[]
  findings: Finding[]
  unscannable: { filename?: string; type: string; mediaType?: string }[]
  decisions: Record<string, Decision>   // typeId -> decision, default 'redact'
  view: 'review' | 'settings'
}
```

Session state (`$.state`, declared in `types/index.d.ts` under `pii-guard`):

- `review: Review | null` — the review currently shown, or none.
- `sessionAllows: string[]` — type ids allowed for the rest of the session.
- `settingsOpen: boolean` — the pane is showing settings with no review.

Persistent config lives in `$.store` under key `config`. Session allows are
deliberately not persisted.

### Config merge on load

On every load, built-in types are merged into the stored config by id: a stored
entry keeps its `enabled` flag, a new built-in is added enabled, a removed
built-in is dropped. Custom types are kept verbatim. This lets a new build add
types without wiping toggles.

## Built-in PII types

All ship enabled. Patterns are UK-first with common international forms.

| id | label | category | validator | notes |
| --- | --- | --- | --- | --- |
| email | Email address | contact | none | RFC-ish local@domain |
| phone | Phone number | contact | none | UK 07/01/02/03 forms, +44, generic international +CC with 9-15 digits |
| postcode | UK postcode | contact | none | standard outward/inward regex |
| ni-number | UK National Insurance number | identity | none | two letters, six digits, A-D suffix; excludes invalid prefixes |
| nhs-number | NHS number | health | nhs | 10 digits, spaced or not, mod-11 check |
| passport | Passport number | identity | none | UK 9-digit; labelled context only ("passport" within 40 chars) to limit noise |
| driving-licence | UK driving licence | identity | none | 16-char DVLA format |
| card | Payment card number | financial | luhn | 13-19 digits with optional spaces or dashes |
| iban | IBAN | financial | iban | country code, 2 check digits, up to 30 alphanumerics, mod-97 |
| sort-account | UK sort code and account | financial | none | 00-00-00 followed within 20 chars by 8 digits |
| ssn | US Social Security number | identity | none | 3-2-4 with dashes, excludes 000/666/9xx area |
| ip | IP address | network | none | IPv4 and IPv6; private ranges still reported |
| dob | Date of birth | identity | none | a date within 30 chars after "DOB", "date of birth", "born" |
| secret | API key or secret | secret | none | AWS AKIA, GitHub ghp_/gho_/ghs_, Slack xox, Anthropic sk-ant-, OpenAI sk-, Google AIza, JWT, PEM private key blocks, generic `(api[_-]?key|secret|token|password)\s*[:=]\s*\S{8,}` |
| health | Health terms | health | none | keyword list: diagnosis, diagnosed, prescription, prescribed, medication, condition names from a short common list, ICD-10 code shape `[A-Z]\d{2}(\.\d{1,2})?` only when preceded by "ICD" |
| name | Personal name | identity | none | watchlist terms, plus heuristic below |

### Name heuristic

Regex for `(Mr|Mrs|Ms|Miss|Dr|Prof)\.? [A-Z][a-z]+( [A-Z][a-z]+)?` and for a
bare capitalised pair `[A-Z][a-z]{1,}(?:[-'][A-Z][a-z]+)? [A-Z][a-z]{1,}` not at
sentence start after a full stop. Every heuristic hit is checked against the
allowlist and against a built-in list of common non-person capitalised pairs
shipped in `patterns.ts` (place names, product names, programming terms such
as Claude Code, Visual Studio, New York, United Kingdom, Pull Request, Stack
Overflow). The user's allowlist extends that list; both are consulted.

Watchlist hits are matched whole-word, case-insensitive, and are reported
under the `name` type regardless of capitalisation.

## Detection (`detect.ts`)

```ts
scan(text: string, section: string, config: Config, opts?: { sessionAllows: string[] }): Finding[]
redact(text: string, findings: Finding[], decisions: Record<string, Decision>, numbering: Numbering): { text: string; numbering: Numbering }
compilePattern(source: string): { ok: true; regex: RegExp } | { ok: false; reason: string }
```

Rules:

1. Only enabled types that are not in `sessionAllows` are scanned.
2. Input is capped at 200,000 characters per section; longer text is scanned
   in its first 200,000 characters and the review notes the truncation.
3. Each pattern runs with flags `giu`. All matches are collected, then sorted
   by start and length; a match overlapping an earlier, longer match is
   dropped, so a card number inside an IBAN reports once as IBAN.
4. A type's validator runs on each match and drops failures. Luhn for card,
   NHS mod-11 for nhs-number, IBAN mod-97 for iban.
5. Any match whose value (trimmed, case-insensitive) is in the allowlist is
   dropped.
6. Redaction replaces each finding whose type decision is `redact` with
   `[<PLACEHOLDER>_<n>]`. `n` is per type and per distinct value within one
   review, so the same email everywhere becomes `[EMAIL_1]`. The numbering
   object is threaded across sections so the prompt and its files agree.
7. `compilePattern` rejects a source that does not compile, that is longer
   than 500 characters, or that trips a simple ReDoS lint: a quantified group
   that itself contains a quantifier (`(a+)+`, `(\d*)*`, `(x|xy)+` style
   alternation inside a quantified group). The lint is conservative; it may
   reject a safe pattern, in which case the user is told why and can rewrite it.

## Flow

### prompt.submit

1. If `e.origin.kind === 'plugin'`, `next(e)`: plugin-submitted prompts are not
   the user's typing and have no one at the keyboard.
2. Load config. Scan `e.text` as section `prompt`.
3. Find `@path` mentions in the text (`@` followed by a non-space run that
   resolves, via `$.fs.stat`, to an existing file under the session root or an
   absolute path). Read each with `$.fs.read`, scan as section `file:<abs>`.
   A read failure is noted in the review, not fatal.
4. Collect unscannable attachments from `e.attachments` (type image, audio,
   document).
5. If there are no findings and no unscannable attachments, `next(e)`.
6. If the session has no surface (`$.ui.panes()` reports none placeable, or
   `$.ui.open` resolves `isPlaced: false` with a no-surface reason): redact
   every finding, log one line, `$.ui.toast` is skipped, `next({ ...e, text })`.
   Unscannable attachments pass in this case; the log says so.
7. Otherwise build a `Review`, write it to state, open the pane
   `{ id: 'pii-guard', title: 'PII review', focus: true, closeOnEscape: true,
   holdToasts: true, rows: 24 }`, and await a promise the pane resolves.
8. On Send: compute redacted prompt text; for each `file:` section store its
   findings and decisions in a module-level map keyed by absolute path
   (consumed by `prompt.attachment`); add any `allow-session` type ids to
   `sessionAllows`; clear `review`; close the pane; `next({ ...e, text })`.
9. On Cancel, Escape, or the pane being closed by the person (`ui.close` with
   origin `person` while a review is pending): clear state, close the pane,
   toast "Prompt cancelled in PII review", return
   `{ drop: 'Cancelled in PII review' }`.

### prompt.attachment

For an attachment whose text is a mentioned file with a pending entry in the
per-path map: redact its text with the stored findings and decisions and the
shared numbering, remove the map entry, `next({ ...e, text })`. Any other
attachment passes through.

### tool.call on Read (opt-in)

Only when `config.scanToolReads` is true and `e.agentId` is absent (main loop).

1. `const ran = await next(e)`; if `ran.deny` or `ran.isError`, return it.
2. Scan `ran.text` as section `tool:<tool_use_id>`. No findings: return `ran`.
3. Open the same pane with a `Review` of kind `tool`, await the decision.
4. Send: return `{ result }` where the Read record's `file.content` is the
   redacted text, and `context: ['pii-guard redacted N values in this file']`.
5. Cancel: return `{ deny: 'Read withheld in PII review' }`.

### Session allows

A type in `sessionAllows` is not scanned, so it never triggers a review. It
is listed in the settings view with a "Revoke" button.

## Pane (`review.tsx`)

One `ui.render` hook on `{ component: 'Pane', requestId: 'pii-guard' }` draws
either the review view or the settings view from state. Elements are resolved
per surface with `$.ui.resolve(e)`; on mobile, where `Input` is missing, the
settings view shows entries read-only with a hint to use `/pii`.

### Review view

- Header: "PII review: N findings in M sections" and, when present, "K
  attachments cannot be scanned".
- For each section: a title line (`Prompt`, the file path, or `Read <path>`),
  then the text. Text is drawn as a sequence of `Text` runs; a run that is a
  finding is drawn `inverse` with a per-category colour and its placeholder
  shown after it in dim text, e.g. `dave@example.com [EMAIL_1]`. Sections
  longer than 40 lines are trimmed to 3 lines of context around each finding
  with `…` separators and a line count.
- Findings table: one row per detected type, in order of first appearance:
  label, count, current decision, and three `Button`s: `Allow once`,
  `Allow this session`, `Redact`. The current decision is drawn bold. Default
  is `Redact`.
- Unscannable list: filename and kind, with the note "cannot be scanned; Send
  will include it as-is".
- Footer buttons: `Send` (hotkey `s`), `Cancel` (hotkey `c`), `Settings`
  (hotkey `o`). Send is labelled `Send with N redactions` when any type is
  set to redact.

### Settings view

- Types grouped by category: label, `On`/`Off` button, and for custom types a
  `Remove` button and the pattern source in dim text.
- Watchlist: entries with `Remove`, an `Input` labelled "Add name or term".
- Allowlist: entries with `Remove`, an `Input` labelled "Add false positive".
- "Scan Read tool results" `On`/`Off`.
- Session allows: type ids with `Revoke`.
- `Back` returns to the review when one is pending, otherwise closes the pane.

Every button handler writes through `update($, atom, fn)`; no handler writes
from a value captured at draw time.

## Commands and tool

### `/pii` slash command

Registered in `session.start`, answered by a `command.run` hook.

| form | effect |
| --- | --- |
| `/pii` | open settings view |
| `/pii list` | text listing of types with on/off, watchlist and allowlist counts |
| `/pii on <id>` / `/pii off <id>` | toggle a type |
| `/pii add <id> <regex>` | add a custom type; id becomes `custom:<id>`; regex validated |
| `/pii rm <id>` | remove a custom type |
| `/pii watch <term>` / `/pii unwatch <term>` | watchlist |
| `/pii allow <term>` / `/pii unallow <term>` | allowlist |
| `/pii test <id> <sample text>` | report which substrings the type matches in the sample |
| `/pii reads on|off` | toggle tool-read scanning |

Each form answers `{ text }` describing what changed.

### `pii_patterns` tool

Registered with `$.tool` so the model can call it when the user asks for help
with a pattern. Input schema:

```json
{
  "action": "list | add | remove | test | watch | unwatch | allow | unallow | toggle",
  "id": "string, for add/remove/test/toggle",
  "label": "string, for add",
  "regex": "string, for add",
  "placeholder": "string, for add, default upper-cased id",
  "samples": ["strings, for test: returns which match and the matched substrings"],
  "term": "string, for watch/unwatch/allow/unallow",
  "enabled": "boolean, for toggle"
}
```

`test` works on an unsaved `regex` too, so Claude can iterate before `add`.
The tool's description tells the model to test with positive and negative
samples before adding and to report the result to the user. Adding and
removing go through normal tool permission; the user sees the call.

## Error handling

- A hook failure must never let PII through silently. The `prompt.submit`
  hook wraps its body in try/catch; on an unexpected error it toasts
  "pii-guard failed, prompt held" and returns `{ drop }`. The person can resend
  after fixing the cause. This fails closed.
- A custom regex that throws at compile time is skipped and reported once per
  session in a toast; the rest of the scan proceeds.
- `$.store` write failure toasts the error; in-memory config stays applied for
  the session.
- The pane losing placement mid-review (terminal shrunk) does not drop the
  review; the promise stays pending until a button, Escape or close.

## Testing

`claude plugin test <mod folder>` runs the `*.test.ts` files.

`detect.test.ts`:

- Positive and negative samples for every built-in type.
- Luhn rejects `4111 1111 1111 1112`, accepts `4111 1111 1111 1111`.
- NHS mod-11 rejects a 10-digit number with a bad check digit.
- IBAN mod-97 rejects a transposed IBAN.
- Allowlist suppresses a watchlist hit and a card hit alike.
- Name heuristic drops `Claude Code` and `New York`, keeps `Dr Jane Smith`.
- Overlap: a card number inside an IBAN reports once.
- Numbering: the same email twice becomes `[EMAIL_1]` twice; a second email
  becomes `[EMAIL_2]`; numbering carries across sections.
- `compilePattern` rejects `(a+)+`, accepts `\b\d{3}-\d{4}\b`.
- Session allows exclude a type from findings.

`review.test.ts`, looped over `['terminal', 'desktop']`:

- A prompt with an email and a card opens the pane; pressing `Redact` on card
  and `Allow once` on email then `Send` passes text with the card replaced and
  the email intact.
- `Cancel` drops the prompt with the expected reason.
- A prompt with an image attachment and no text findings opens the pane with
  the unscannable notice; `Send` passes it unchanged.
- `Allow this session` on email, then a second prompt with only an email,
  passes without opening the pane.
- With `scanToolReads` on, a `Read` whose content holds an NI number opens the
  pane; `Send` with redact returns a result whose content is redacted.
- A plugin-origin prompt passes without a scan.
- `/pii add` with an invalid regex answers the reason and stores nothing.
- `pii_patterns` `test` returns the matched substrings for a saved and an
  unsaved regex.

## Security notes

- The mod never logs or toasts matched values; toasts carry counts and type
  labels only. The debug log line in the no-surface path says how many values
  of which types were redacted, not the values.
- Config is stored in the mod's own store file under the user's Claude
  configuration directory. The watchlist holds names, which are themselves
  PII; the README says so and advises keeping that directory private.
- The default decision is redact and the no-surface path redacts everything,
  so an unattended run cannot send flagged values.

## v1 as built: deviations from the flow above

Found during implementation and the final review; the code is the authority where this section and the flow disagree.

1. **Drop and resubmit instead of awaiting the pane.** A hook's 10-second budget keeps running while it awaits anything that is not a `$` call, so the `prompt.submit` hook cannot wait for a pane press. It drops the prompt with `Held for PII review`, shows the pane, and the pane's Send button resubmits the redacted text with `$.prompt.submit({ text, asUser: true })`. Reviews queue behind the one shown. The plugin's own hooks do not see its own resubmit, so mentioned files ride inside the resubmitted text (redacted) rather than as `context`, and the placeholder guidance is a session-scoped `prompt.compose` section added once anything was redacted.
2. **Attachments present: the engine dialog decides.** A resubmit cannot carry images, PDFs or audio, so such prompts are decided with `$.ui.ask` (a `$` call, budget-safe): redact text and send, send as-is, or cancel. The pane shows the findings alongside.
3. **Read gate decides in the dialog, all types at once.** `$.ui.ask` with Redact / Allow once / Allow this session / Withhold; the pane shows the hit. Any failure after the read ran withholds the result.
4. **File attachments are rescanned, never matched by path.** Every main-loop `file` attachment is rescanned and redacted with the last sent prompt's decisions (default redact), with a toast when anything was redacted.
5. **Headless detection** asks `$.session.surfaces()` at prompt time: empty means nobody can answer. The desktop app is SDK-hosted (`isInteractive` false, no surface at start) and attaches its surface later, so neither the origin kind nor the start-time flag is usable.
6. **Slash-command skip** applies only when the first token names a registered command (`$.command.list()`).
7. **`pii_patterns` can only strengthen the guard**: list (counts, never entries), test, add, watch, enable. Weakening actions are `/pii` only. Subagent calls are refused.
8. **ReDoS lint** is a small parser: an unbounded repeated group that contains a variable-width quantifier or an alternation is refused; bounded repeats are allowed.
9. **`PiiType.caseSensitive`** added; the name heuristic compiles without the `i` flag.

## v1.1 additions (2026-10-11)

### Word-level allowlist for the name heuristic

A hit produced by the capitalised-pair heuristic (never a watchlist hit, never
another type) is dropped when any whole word of it, lower-cased, is a
single-word allowlist entry. `microsoft` therefore covers Microsoft Teams and
Microsoft Azure. The default allowlist becomes a list of vendor, product and
place words plus a few pairs that have no safe single word.

### Allowlist from the review pane

Under each detected type the pane lists the distinct values found (at most 10,
then "+N more"), each with an **Allowlist** button that adds the exact value to
the user's allowlist, saves, and removes its findings from the current review.
For the name type each word of a pair also gets an **Allowlist "Word"** button.
If no findings and no unscannable attachments remain, the held prompt is sent
unchanged at once and a toast says so.

### Policy file

`plugin.json` declares one `userConfig` option, `policyFile` (string path). An
administrator sets it in managed settings under
`pluginConfigs["pii-guard@<marketplace>"].options.policyFile`; a user may set
it in their own settings. Unset, nothing changes.

The file is JSON; every key optional:

```json
{
  "version": 1,
  "watchlist": ["Acme Ltd"],
  "allowlist": ["acme code"],
  "types": { "email": { "enabled": true }, "name": { "enabled": false } },
  "customTypes": [{ "id": "acme-ref", "label": "Acme reference", "regex": "\bACME-\d{6}\b", "placeholder": "ACMEREF" }],
  "scanToolReads": true
}
```

The policy is overlaid on the user's stored config at every load. Policy
watchlist and allowlist entries, policy custom types, the enabled state of any
type the policy names, and `scanToolReads` when present are **locked**: the
pane shows a lock marker and no control, `/pii` and `pii_patterns` refuse to
change them. Policy regexes pass the same lint; a rejected one is skipped and
reported. The file is re-read when its modification time changes. A set path
whose file is missing or malformed produces one toast per session and a debug
log line, and the user's config applies alone: a broken policy must not stop
prompts.

`/pii list` marks locked rows `policy`; the settings pane shows the policy
path and its last load time.

### Pane redesign (tier 1)

Header line with counts; one bordered card per detected type, border and badge
in the category colour, values as chips with the Allowlist buttons, the three
decision buttons beneath; two columns of cards from 120 body columns; footer
with hotkeys. Same tree on every surface.

### Local session-log scrub (v1.2)

The engine writes the typed prompt to the session's `.jsonl` as
`queue-operation` and `last-prompt` records before any hook runs; a dropped
prompt therefore persists on disk even though it never reaches the model. The
mod learns the log's path from the classic `UserPromptSubmit` event and, after
a redaction (pane Send, headless, or the attachment dialog's redact), stars out
each redacted value in those record lines only, in place and byte-length
preserving, through a child process (`powershell` on Windows, `perl`
elsewhere), so a concurrent append cannot be lost. Where no child process can
run and the log is under 4 MiB, `$.fs` rewrites it instead. Conversation
messages are never touched. Failure warns once per session. `scrubLog`
(default true) in the config; `/pii scrub on|off`; a settings toggle.

### Dictionary tier (v1.3)

Pure code, no model. `tools/build-dictionaries.py` generates
`pii-guard/hooks/data/*.ts` from public-domain sources (SSA first names via
the hadley mirror, US Census surnames, google-10000-english, CMS ICD-10-CM
category titles, FDA Drugs@FDA). `hooks/dictionary.ts` adds to the `name`
type any-case `first surname` pairs (listed surname: high confidence; a word
that is neither common English nor a stopword: medium) and to the `health`
type listed conditions and drugs (high) plus medical suffixes with an
exclusion set (medium). `Finding.confidence` is optional; the pane marks
medium values "likely". `nameDictionary` (default true) toggles the name
tier; `/pii names on|off`. Patterns may start with `(?i)` to run
case-insensitively inside a case-sensitive type; the `name` type uses this
for cue phrases ("my name is garry bellows").

### Enterprise enforcement and the user switch (v1.4)

Policy gains `enabled`, `scrubLog`, `nameDictionary` (presence locks) and
`lists.{watchlist,allowlist}: "locked"|"open"` (freezes a list against any
user change). A `policyJson` option carries the policy inline; it merges with
`policyFile`, the file's scalars winning. The managed tier is detected from
`$.config.list()` rows whose key is the option and `isLocked` is true; the
pane then shows "Managed by your organisation". Config gains `enabled` (all
sessions) and state gains `paused` (this session); `/pii pause|resume|
disable|enable`, settings buttons, and `$.ui.status` while off. The gate,
the Read gate and the attachment rescan all pass through while inactive. A
policy `enabled: true` overrides a user disable and hides both switches:
organisation enforcement always wins.

### Local-model tier (planned, not scheduled)

An opt-in HTTP call to a local NER endpoint (localhost or private address
only, policy-lockable) whose entities merge as findings. For home use; work
use needs organisational sign-off.

### Direction for the pane

If mods become available in desktop chat or Cowork, a `Client` surface module
becomes the primary pane and the tier 1 tree the fallback where the surface
cannot host one.

## v2 backlog

Recorded here so it is not lost:

1. Subagent prompts: hook chains with `agentId` set, and the `Agent` tool's
   prompt argument, through the same pane.
2. Bash and Grep tool output scanning alongside Read, with a per-tool toggle.
3. Per-project configuration: a `.pii-guard.json` in the project root that
   overrides the global toggles, watchlist and allowlist, and per-project
   remembered decisions keyed by working directory.
4. A compact band above the prompt showing the session's allowed types with a
   one-press revoke.
5. Export and import of custom pattern sets.
6. Per-type decisions on the Read path (today all-or-nothing in the dialog).
7. Guard `Write`/`Edit` against placeholders handed out this session.
8. Numbering that persists across prompts in a session, so `[EMAIL_1]` means one person throughout.
9. Notice when a non-text `Read` record (notebook, image) is passed unscanned, and when the 200k scan cap truncates a clean section.
10. Decouple the watchlist from the `name` type so turning the heuristic off keeps the watchlist.
