# Changelog

All notable changes to pii-guard. Versions are git tags on `main`.

## 1.4.1 — 2026-10-11

- Session state moved out of `$.state` into the hooks module, with redraws through `$.ui.invalidate`. The manifest no longer needs a `types` contract, so the copy the claude.ai organisation marketplace sync produces (which strips that key) now loads. A hot reload while a review is open drops that review.
- The mod README carries the install line.

## 1.4.0 — 2026-10-11

- Policy can force the gate on (`enabled`), lock the log scrub and the name dictionary, and freeze whole lists (`lists.watchlist` / `lists.allowlist`: `locked`).
- `policyJson` option carries an inline policy; merges with `policyFile`.
- Managed settings detected from locked config rows; the pane shows "Managed by your organisation".
- User switch when no policy enforces the gate: `/pii pause` / `resume` (session), `/pii disable` / `enable` (all sessions), settings buttons, status line while off.
- Organisation enforcement overrides a user's earlier disable.

## 1.3.0 — 2026-10-11

- Dictionary tier: any-case `first surname` names (SSA first names, US Census surnames; listed surname = high confidence, uncommon word = "likely"), with its own toggle (`/pii names`).
- Health terms from about 930 ICD-10-CM category titles and lay terms, about 2,500 FDA drug names, and medical word shapes (-itis, -oma, -ectomy, shown as "likely").
- Lowercase names introduced by a cue phrase ("my name is garry bellows", "I'm called", "call me").
- Patterns may start with `(?i)` to run case-insensitively inside a case-sensitive type.
- `tools/build-dictionaries.py` regenerates the word lists from public-domain sources.

## 1.2.0 — 2026-10-11

- Local session-log scrub: after a redaction, or a cancelled review, the typed values are starred out in place in the log's queue records, byte-length preserving, through PowerShell or perl (fs fallback for small logs). Conversation messages are never touched. `/pii scrub on|off`.
- Headless detection by attached surfaces, so the desktop app gets the pane.

## 1.1.0 — 2026-10-10

- Word-level allowlist: a single-word entry suppresses any capitalised name pair containing it; defaults cover common vendors, products, places and days.
- Review pane redesign: one bordered card per detected type, values with **Allowlist** buttons (per word for name pairs); sends as typed when nothing is left.
- Organisation policy file (`policyFile` option): watchlist, allowlist, type states, custom types and Read scanning, overlaid and locked; a policy watchlist name can never be allowlisted.

## 1.0.0 — 2026-10-10

- First release. Prompt gate with per-type Allow once / Allow this session / Redact, numbered placeholders, `@file` read-ahead, opt-in Read gate, attachments decided in the engine dialog, `/pii` command, model-callable `pii_patterns` tool that can only strengthen the guard, 16 built-in types with Luhn, NHS and IBAN checks, ReDoS-linted custom patterns, marketplace install, MIT.
