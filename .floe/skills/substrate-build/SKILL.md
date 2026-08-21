# substrate-build

Use this skill only for deliberate engineering work on the Floe substrate.

It is not attached to the default operator-facing Floe actor.

Before changing the substrate:

1. identify the real attempted operation that exposed the blocker;
2. verify the blocker in current code/runtime behaviour;
3. test whether actor behaviour, existing composition, a tool, workspace capability, or external extension can solve it first;
4. make the smallest general substrate change only when those layers are insufficient;
5. rerun the original operation after the change.

Preserve established daemon/runtime boundaries and standing invariants in `AGENTS.md` unless real evidence explicitly justifies reconsidering them.

Do not create speculative primitives, architecture programmes, issue trees, or UI coverage merely because a mechanism could be useful.
