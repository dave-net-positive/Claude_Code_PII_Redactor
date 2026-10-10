# pii-guard

A Claude Code mod that holds prompts containing PII or secrets behind a review pane before they reach the model.

## What it scans

- The prompt as typed, pastes included.
- Files pulled in with `@path`, shown as their own sections in the same review and redacted when the engine attaches them.
- Optionally (off by default) the content the `Read` tool returns, mid-turn.
- Images, PDFs and audio cannot be scanned: the mod never sees their bytes. They are listed in the review so you can Send or Cancel knowingly.

## The review

Each detected type gets a row: **Allow once**, **Allow this session**, **Redact** (the default). Send applies the choices; Cancel, Escape or closing the pane drops the prompt. Redacted values become numbered placeholders, `[EMAIL_1]`, `[CARD_2]`, the same value always getting the same number within one prompt and its files, so Claude can still reason about "the second email".

In a headless `claude -p` run there is nobody to ask, so everything flagged is redacted and the run continues. If the mod itself fails, the prompt is held rather than sent.

## Built-in types

email, phone, UK postcode, NI number, NHS number (mod-11 checked), passport, UK driving licence, payment card (Luhn checked), IBAN (mod-97 checked), UK sort code + account, US SSN, IP address, date of birth, API keys and secrets, health terms, personal names (watchlist plus a capitalised-pair heuristic filtered by an allowlist). All start enabled.

## Configuration

- `/pii` opens the settings pane: toggle types, edit the names watchlist and the allowlist, turn Read scanning on.
- `/pii add <id> <regex>` adds a custom type; `/pii test <id|regex> <sample>` tries one; `/pii list` shows everything.
- Ask Claude: "add a pattern for our internal ticket ids like REF-123456". It uses the `pii_patterns` tool to test the regex against samples and add it. The addition shows as a normal tool call you approve.

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
