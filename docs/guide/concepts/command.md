# Command

**A command is deterministic work, backed by a file that meets the command contract.**

Where an [[Actor]] reasons and its output needs judgement, a command just runs. Given
the same inputs, it produces the same raw facts every time. That is why it can be
re-run, cached, and trusted without a human or model reading the output.

## The contract

A command declares:

- **named inputs** — resolved by name from the triggering [[Event]]'s `content`, keyed by `content_key`
- **named outputs** — mapped from raw execution facts
- raw execution facts, always available: `exit_code`, `passed`, `stdout`, `stderr`

If a declared input is `required` and missing from the event content, the command
fails before it runs rather than running with a gap.

## `{{name}}` substitution

The command string itself is a template. Each resolved input value is substituted for
`{{name}}` before the shell runs it:

```
echo "{{branch}} deployed"
```

resolves to `echo "main deployed"` once `branch` resolves to `main`.

## The return path

A command isn't called by a node — a node is just the declaration. **It is called by
a working space run** (`called_by`), and its result returns to *that run*, not to the
command's declaration. Five separate contexts can each call the same command node at
once; each gets its own result back, because each call is scoped to the run that made
it. This is why concurrent runs of the same command never cross wires.

## Implementation

- `floe-bridge/src/command-runner.ts` — input resolution, `{{name}}` substitution, execution, output mapping
- `floe-bus/src/scope-graphs.ts` — `ScopeGraphCommandInput`, `ScopeGraphCommandOutput` shapes (storage vocabulary only; the model is Command, not the graph naming)
- `floe-bus/src/server.ts` — `POST /v1/workspaces/:workspace_id/graphs/:graph_id/nodes/:node_id/fire`

See [[Glossary]].
