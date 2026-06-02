# Issue #33 Field-as-Scope live acceptance

Fresh real bus-backed live QA for [#33](https://github.com/floe-ai/floe-subtrate/issues/33).

## Result

- Git SHA: `3623c90dd1a8cbba7b6a811a7d135495e2a2916b`
- Workspace: `Issue 33 Field-as-Scope QA mpkqxwqz`
- Workspace path: `C:\Users\jfenech\.copilot\session-state\550f4e57-e2f7-4b7f-9df7-506521059e7f\files\issue33-field-as-scope-live-qa\workspace`
- Created Scope/Field: `scope_245233eb-d9f3-4a45-9757-1c57ccde09b6`
- Context: `ctx_8593f751-371b-4eb0-822a-5d1965936b43`
- Pulse: `issue33_scope_acceptance_mpkqxwqz`

## Acceptance checklist

- [x] Fresh workspace shows Default Scope as a Field.
- [x] Creating a Field creates a Scope and the new Scope appears as a Field.
- [x] Opening a Field renders the Scope Projection returned by the bus.
- [x] Scoped Context nodes open through the existing conversation/sidebar path.
- [x] Scoped Pulse nodes and subscriber relationships render from Pulse state.
- [x] Moving nodes and reloading preserves layout without changing projection membership.
- [x] Evidence shows no `.floe/blocks`, no Field-owned canonical item list, and no Field-owned canonical connection graph.
- [x] Browser console/client logs and bus/bridge logs show no relevant errors.
- [ ] Human reviewer confirms the visible UX matches "Scope is substrate; Field is rendering."

## Evidence

- `screenshots\01-default-scope-field-list.png`
- `screenshots\02-created-field-is-scope.png`
- `screenshots\03-projection-renders-context-pulse-edge.png`
- `screenshots\04-context-node-opens-conversation.png`
- `screenshots\05-layout-persists-after-reload.png`

Additional machine-readable evidence:

- `live-qa-summary.json`
- `projection-before-layout.json`
- `projection-after-reload.json`
- `layout-after-move.yaml`
