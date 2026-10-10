# pii-guard

A Claude Code mod that holds prompts containing PII or secrets behind a review pane before they reach the model.

## What it scans

- The prompt as typed, pastes included.
- Files pulled in with `@path`, shown as their own sections in the same review and redacted when the engine attaches them.
- Optionally (off by default) the content the `Read` tool returns, mid-turn.
- Images, PDFs and audio cannot be scanned: the mod never sees their bytes. They are listed in the review so you can Send or Cancel knowingly.

## The review

When a prompt contains PII the mod holds it (the transcript shows it was held) and opens the review pane. Each detected type gets a row: **Allow once**, **Allow this session**, **Redact** (the default). **Send** resubmits the prompt as your own words with the redactions applied; the transcript names pii-guard as the sender. **Cancel**, Escape or closing the pane discards the held prompt. Prompts that arrive while a review is open queue behind it.

Redacted values become numbered placeholders, `[EMAIL_1]`, `[CARD_2]`, the same value always getting the same number within one prompt and its files, so Claude can still reason about "the second email". Once anything has been redacted, Claude's system prompt carries a standing note that placeholders stand for redacted values and must never be written into files.

Files you mentioned with `@path` are shown as their own sections and, on Send, appended to the resubmitted prompt with the same redactions applied.

A prompt that carries an image, PDF or audio attachment cannot be resubmitted with the attachment, so it is decided in Claude Code's own question dialog instead: redact the text and send, send everything as-is, or cancel. The pane still shows what was found.

Where nothing draws (a `claude -p` run) there is nobody to ask, so everything flagged is redacted and the run continues. The desktop app counts as interactive once its window is attached. If the mod itself fails, the prompt is held rather than sent.

### Read tool results (opt-in)

With "Scan Read tool results" on, a `Read` whose content contains PII is decided in the question dialog mid-turn: redact and continue, allow once, allow this session (all types found in that file), or withhold the result. Any failure in that path withholds the result.

## Built-in types

email, phone, UK postcode, NI number, NHS number (mod-11 checked), passport, UK driving licence, payment card (Luhn checked), IBAN (mod-97 checked), UK sort code + account, US SSN, IP address, date of birth, API keys and secrets, health terms, personal names (watchlist plus a capitalised-pair heuristic filtered by an allowlist). All start enabled.

## Configuration

- `/pii` opens the settings pane: toggle types, edit the names watchlist and the allowlist, turn Read scanning on.
- `/pii add <id> <regex>` adds a custom type; `/pii test <id|regex> <sample>` tries one; `/pii list` shows everything.
- Ask Claude: "add a pattern for our internal ticket ids like REF-123456". It uses the `pii_patterns` tool to test the regex against samples and add it. The tool can only strengthen the guard: list, test, add a type, add a watchlist name, turn a type on. Turning types off, removing types, allowlisting and unwatching are yours alone through `/pii`, so a prompt injection cannot switch the guard off. The tool never returns watchlist or allowlist entries, only counts.

Custom regexes get flags `giu`, must be 500 characters or fewer, and are rejected if they nest quantifiers or match the empty string.

Config is stored in the mod's own store file under your Claude configuration directory. The watchlist holds names, which are themselves personal data: keep that directory private.

## Developing

Source lives in this repo. Load it for a session with:

    claude --plugin-dir "E:\LLM Config\Mods\pii-guard"

Checks (use a `claude` binary of the same build that wrote `.claude-plugin/types`):

    claude plugin validate pii-guard
    npx -y -p typescript@5.6 tsc -p pii-guard
    claude plugin test pii-guard

## Not in v1

Subagent prompts, Bash and Grep output, per-project configuration, image or PDF content scanning. See `docs/superpowers/specs/2026-10-10-pii-guard-design.md`, section "v2 backlog".
