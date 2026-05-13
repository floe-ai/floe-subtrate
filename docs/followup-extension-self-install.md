# Follow-up: Extension Self-Install/Enable

**Status:** Tracked, not yet implemented  
**Priority:** Next substrate pass  
**Related:** PRD §2 (Extension Substrate), ADR-0002

## Current State

Extensions work end-to-end when manually installed:
- Place extension in `.floe/extensions/NAME/` (extension.json + entry point)
- Declare `extensions: ["NAME"]` in agent frontmatter
- Bridge discovers and loads on workspace attach

## Gap

An agent cannot currently:
1. Create a new extension directory
2. Write extension.json and entry point files
3. Enable the extension for itself or another actor
4. Trigger the bridge to reload/discover the new extension

A user or developer must manually copy files and edit frontmatter.

## Required Capabilities

1. **Agent tool: `create_extension`** — writes extension directory, manifest, and entry point
2. **Agent tool: `enable_extension`** — adds extension name to an actor's frontmatter `extensions:` array
3. **Bridge hot-reload** — detect new extensions without full workspace re-attach (currently relies on 30s config drift reconciliation, which works but requires config hash change)
4. **Validation** — ensure extension manifest is valid before enabling
5. **Security** — extensions run with full workspace access; self-install should respect any future trust model

## Design Considerations

- Extension creation is a file operation (workspace tools already exist)
- The gap is really about **enabling** (editing agent frontmatter) and **reloading** (bridge picks up changes)
- Config drift detection already handles the reload case — if `create_extension` also edits `floe.yaml` or agent frontmatter, the bridge will reconcile within 30s
- For V1, a simpler approach may work: agent uses `write` tool to create extension files + `edit` tool to update its own frontmatter, then waits for reconciliation

## Not Blocked By

- Extension loading works ✅
- Tool auto-prefixing works ✅  
- Hook registration works ✅
- Config drift reconciliation works ✅
