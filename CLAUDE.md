# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A collection of Claude Code skills for Mixin Network development. Each skill is a `SKILL.md` file that Claude loads contextually when relevant keywords appear. There is no build system, no tests, no compiled code — this is a pure documentation/prompt repo.

## Installing skills

```bash
npx skills add LixvYang/mixin-skills
npx skills add LixvYang/mixin-skills --skill mixin-computer -g -a claude-code
```

## Authoring a new skill

1. Create `skills/<skill-name>/SKILL.md` with required frontmatter:

```markdown
---
name: mixin-<topic>
description: <one-sentence trigger description — this is what the CLI uses to match>
---
```

2. Add a row to the skills table in `README.md`.
3. Add the skill name to the index in `skills.json` (if it exists).

The `name` field must match the directory name. The `description` drives when Claude activates the skill — make it specific and keyword-rich.

## Skill design rules

- **Cover both Go and Node.js** unless the feature is language-specific (MTG/mixin-kit-go are Go-only; note this explicitly).
- **Progressive disclosure**: start with the minimal code pattern, then add edge cases below.
- **Code examples must be self-contained** — a reader should be able to copy-paste and run.
- The `mixin-architecture` skill is the router/overview; it should reference other skills but not duplicate their content.

## Mixin domain knowledge

The README contains the authoritative overview of the SDK landscape, bot identity model, and two key separations (session key vs. spend key; legacy transfer vs. Safe UTXO). Read it before editing any skill.

Key invariants that must not be violated in any code example:
- Never load `spend_private_key` in code paths that don't move money.
- Never rotate a `trace_id` / `request_id` / `message_id` inside a retry loop — Mixin uses these for deduplication.
- `app_id` == `user_id` for bots; the Go SDK surfaces it as `SafeUser.UserId`.
