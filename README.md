# Claude Code PII Redactor

A [Claude Code](https://claude.com/claude-code) mod, **pii-guard**, that stops personal data and secrets reaching the model by accident. When a prompt contains an email address, a card number, an NHS or National Insurance number, an API key, a name on your watchlist or anything else it recognises, the prompt is held and a review pane opens. You choose, per type, whether to send the value as-is, allow it for the rest of the session, or redact it to a placeholder like `[EMAIL_1]`. Nothing leaves until you press Send.

Detection is plain regex with checksum validation where one exists (Luhn for cards, mod-11 for NHS numbers, mod-97 for IBANs). You can turn any type off, add your own patterns, and ask Claude to write and test a pattern for you.

## Requirements

- Claude Code **2.1.295 or newer**. Check with `claude --version`; update with `claude update`.
- A terminal to run the install command in. The mod then works in the terminal and in the Claude desktop app alike.

## Install

In a Claude Code terminal session, at the prompt:

```
/plugin install pii-guard --marketplace dave-net-positive/Claude_Code_PII_Redactor
```

You will be asked three things:

1. `Add marketplace?` naming `github:dave-net-positive/Claude_Code_PII_Redactor`. Answer `y`.
2. A scope. Press Enter for **user**, so the mod runs in every session, including the desktop app.
3. Nothing else. You should see `Installed pii-guard. Plugin is now active.`

The mod is live in that session immediately and in every session you start afterwards.

The desktop app's Code tab cannot run the install command itself. Install from a terminal once; the user-scope install covers the app.

## Try it

Send a prompt such as:

```
my email is test@example.com and my card is 4111 1111 1111 1111
```

The prompt is held and the review pane opens with both values highlighted. Press **Send** (or `s`) to send with the default redactions, and the model receives `[EMAIL_1]` and `[CARD_1]`. Press **Cancel** (or Escape) to discard the prompt.

## What it scans

| Source | Behaviour |
| --- | --- |
| The prompt you type, pastes included | Held for review |
| Files mentioned with `@path` | Shown as their own sections in the same review, appended redacted on Send |
| Images, PDFs, audio | Cannot be scanned (the mod never sees their bytes). A prompt carrying one is decided in Claude Code's question dialog: redact the text and send, send as-is, or cancel |
| `Read` tool results | Off by default. Turn on in `/pii` to be asked mid-turn: redact, allow once, allow this session, or withhold |

Where nothing can draw a pane (a `claude -p` run) everything flagged is redacted and the run continues. If the mod itself fails, the prompt is held rather than sent.

## Built-in types

All start enabled. Turn off the ones a project tolerates.

| Type | Notes |
| --- | --- |
| Email address | |
| Phone number | UK and international forms |
| UK postcode | |
| UK National Insurance number | |
| NHS number | mod-11 checked |
| Passport number | 9 digits near the word "passport" |
| UK driving licence | |
| Payment card number | Luhn checked |
| IBAN | mod-97 checked |
| UK sort code and account number | |
| US Social Security number | |
| IP address | v4 and v6 |
| Date of birth | a date near "DOB", "date of birth" or "born" |
| API key or secret | AWS, GitHub, Slack, Anthropic, OpenAI, Google keys, JWTs, PEM private keys, `password=` style assignments |
| Health terms | a short keyword list and ICD-10 codes |
| Personal name | your watchlist, a capitalised-pair heuristic, and any-case names introduced by a cue ("my name is garry bellows"); a pair is ignored when any of its words is on the allowlist |

## Configuration

- **In the review itself** every detected value has an **Allowlist** button, and each word of a flagged name pair has its own, so one press on "Microsoft" stops every Microsoft product being flagged again. When nothing is left to review the prompt is sent as typed.
- **`/pii`** opens the settings pane: toggle types, edit the names watchlist and the false-positive allowlist, turn Read scanning on, turn the local log scrub off. A single-word allowlist entry suppresses any name pair that contains it; the default list covers common vendors, products, places and days.
- **`/pii add <id> <regex>`** adds a custom type. **`/pii test <id|regex> <sample text>`** shows what a pattern matches. **`/pii list`** shows everything.
- **Ask Claude.** "Add a pattern for our ticket ids like REF-123456" makes Claude use the `pii_patterns` tool to test a regex against samples and add it. The tool can only strengthen the guard (list, test, add a type, add a watchlist name, turn a type on). Turning types off, removing them, allowlisting and unwatching are yours alone through `/pii`, so an injected instruction cannot switch the guard off.

Custom regexes run with flags `giu`, must be 500 characters or fewer, and are rejected if they nest an unbounded repeat around a variable-width quantifier or match the empty string.

Settings live in the mod's own store file under your Claude configuration directory. The watchlist holds names, which are personal data in their own right: keep that directory private.

## Organisation policy (admins)

An administrator can push settings that users cannot change. Point the mod at a policy file through its `policyFile` option in managed settings (the same file you use for `enabledPlugins`):

```json
{
  "pluginConfigs": {
    "pii-guard@net-positive-mods": {
      "options": { "policyFile": "C:\\ProgramData\\pii-guard\\policy.json" }
    }
  }
}
```

The policy file is JSON; every key is optional:

```json
{
  "version": 1,
  "watchlist": ["Acme Ltd", "Project Nightjar"],
  "allowlist": ["acme code"],
  "types": { "email": { "enabled": true }, "name": { "enabled": false } },
  "customTypes": [
    { "id": "acme-ref", "label": "Acme reference", "regex": "\\bACME-\\d{6}\\b", "placeholder": "ACMEREF" }
  ],
  "scanToolReads": true
}
```

Everything the policy names is overlaid on each user's own settings and **locked**: the settings pane shows a lock instead of a button, and `/pii` and the `pii_patterns` tool refuse to change it. Anything the policy does not mention stays the user's to set. The file is re-read whenever its modification time changes, so an edit lands without a restart. If the path is set but the file is missing or malformed, the user sees one warning per session and their own settings apply alone; a broken policy never blocks prompts.

Distribute the file by MDM, a share, or a repo checkout. Keep it readable by the user account Claude Code runs as.

## What is and isn't protected

Tested by searching this machine after a redacted prompt:

- **The model and the API.** A held prompt never becomes a conversation message. Only the redacted resubmission does, so no later turn can carry the original. Allowed values, and anything sent before the mod was active, are in the conversation for good.
- **Your local session log.** Claude Code writes what you typed to the session's `.jsonl` before any hook runs, in `queue-operation` and `last-prompt` records. After a redaction the mod patches those records in place, replacing each redacted value with the same number of `*` so the file's structure is untouched. This runs through PowerShell on Windows and perl elsewhere, with a plain file rewrite as a fallback for logs under 4 MB. It is best effort: it cannot reach backups, sync copies, or the app's memory, and the UI keeps showing what you typed until the session reloads. Turn it off with `/pii scrub off`.
- **Not covered.** Subagent prompts, `Bash` and `Grep` output, image or PDF content, and whatever the desktop app may send on its own.

## Placeholders

Redacted values become numbered placeholders, the same value always getting the same number within one prompt and its files, so Claude can still reason about "the second email". Once anything has been redacted, Claude's system prompt carries a standing note that placeholders stand for real values and must never be written into files.

## Known limits (v1)

- Subagent prompts, and `Bash` and `Grep` output, are not scanned.
- On the Read path the decision covers every type found in that file at once.
- Configuration is per user plus an optional organisation policy; there is no per-project layer yet.
- Image and PDF *content* is never scanned.

See the [design spec](docs/superpowers/specs/2026-10-10-pii-guard-design.md) for the full v1 behaviour and the v2 backlog, and [pii-guard/README.md](pii-guard/README.md) for the mod's own notes.

## Developing

Clone the repo and load the mod from its folder instead of installing it:

```bash
claude --plugin-dir "<repo>/pii-guard"
```

Checks, with a `claude` binary of the same build that wrote `pii-guard/.claude-plugin/types`:

```bash
claude plugin validate pii-guard
npx -y -p typescript@5.6 tsc -p pii-guard
claude plugin test pii-guard
```

## Uninstall

```
/plugin uninstall pii-guard
```

## Licence and author

MIT, see [LICENSE](LICENSE). Dave Wilbourn, [net-positive.uk](https://net-positive.uk). Issues and pattern suggestions welcome on GitHub.
