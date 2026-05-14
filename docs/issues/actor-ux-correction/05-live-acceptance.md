# Issue: Live acceptance — actor-neutral + no-bleed proof

## Summary

Final live QA pass proving the full actor UX correction works end-to-end.

## Acceptance criteria

1. **Context bleed**: Select floe → see only operator↔floe contexts. Floe↔reviewer contexts invisible.
2. **Delivery symmetry**: Actor with bridge receives delivery. Actor without bridge sees events via poll. No `actor_type` anywhere in codebase routing/query logic.
3. **Operator name**: Set a custom name → messages show it. Bus record is source of truth.
4. **Actor-neutral UI**: No "Humans"/"Agents" section, no "Bot" icon, no raw IDs, no `actor_type` in visible DOM.
5. **No `actor_type` in bus**: `git grep actor_type -- floe-bus/src/` returns zero matches.
6. **No `actor_type` from FloeWeb**: registration body and all API calls contain no `actor_type` field.
7. **Live regression**: Ask an actor "Can you guess if I am human or agent? Give evidence and confidence." Actor must not cite substrate metadata. May guess from style only, with limited confidence.
8. **No stale leakage**: `list_endpoints`, `resolve_destination`, delivery context, and context participants shown to the runtime contain no `actor_type`, no `human`/`agent` category, no raw `endpoint:` IDs.
9. **Existing behaviour**: First message creates context lazily. Continuing sends context_id. Pulse contexts are target-only. Work/activity is separate from messages.

## Process

- Start bus + bridge + FloeWeb fresh (wipe data dir).
- Drive manual HITL through each criterion.
- Capture evidence bundle per criterion:
  - Screenshot or UI observation
  - Relevant API response/log excerpt
  - `git grep` result where applicable
  - Explicit pass/fail verdict

## Evidence bundle required

Each criterion must have documented evidence. Final report format:

| # | Criterion | Verdict | Evidence |
|---|-----------|---------|----------|
| 1 | Context bleed | PASS/FAIL | screenshot/log |
| 2 | Delivery symmetry | PASS/FAIL | API response |
| 3 | Operator name | PASS/FAIL | screenshot |
| 4 | Actor-neutral UI | PASS/FAIL | DOM inspection |
| 5 | No actor_type in bus | PASS/FAIL | grep result |
| 6 | No actor_type from FloeWeb | PASS/FAIL | network log |
| 7 | Live regression | PASS/FAIL | actor response |
| 8 | No stale leakage | PASS/FAIL | tool/prompt output |
| 9 | Existing behaviour | PASS/FAIL | functional test |

## Depends on

- Issue 01 (delivery symmetry)
- Issue 02 (context bleed fix)
- Issue 03 (operator identity)
- Issue 04 (conversation panel UX)
