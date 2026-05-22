# Field file evidence

Workspace fixture: `examples\sample-project`
Field semantic path: `examples\sample-project\.floe\fields\inbound-pr-review.yaml`
FloeWeb layout path: `examples\sample-project\.floe\fields\inbound-pr-review.layout.floeweb.yaml`

## After FloeWeb Field create
```yaml
schema: floe.field.v1
id: inbound-pr-review
title: Inbound PR Review
items: []
connections: []
created_at: 2026-05-22T01:24:43.233Z
updated_at: 2026-05-22T01:24:43.237Z
```

## After FloeWeb Actor Item add
```yaml
schema: floe.field.v1
id: inbound-pr-review
title: Inbound PR Review
items:
  - item_id: actor-floe
    ref: actor:workspace:317635fab942b83a:floe
connections: []
created_at: 2026-05-22T01:24:43.233Z
updated_at: 2026-05-22T01:24:43.884Z
```

## Layout sidecar after React Flow move
```yaml
schema: floe.field.layout.floeweb.v1
field_id: inbound-pr-review
viewport:
  x: 0
  y: 0
  zoom: 1
items:
  actor-floe:
    x: 245
    y: 162
    width: 150
    height: 40
```

## After actor ordinary edit tool
```yaml
schema: floe.field.v1
id: inbound-pr-review
title: Inbound PR Review
items:
  - item_id: actor-floe
    ref: actor:workspace:317635fab942b83a:floe
  - item_id: context-inbox
    ref: context:inbox
connections: []
created_at: 2026-05-22T01:24:43.233Z
updated_at: 2024-06-10T17:52:00.000Z
```

## After external stop/restart YAML edit
```yaml
schema: floe.field.v1
id: inbound-pr-review
title: Inbound PR Review - external edit
items:
  - item_id: actor-floe
    ref: actor:workspace:317635fab942b83a:floe
  - item_id: context-inbox
    ref: context:inbox
connections:
  - id: actor-to-inbox-external
    from: actor-floe
    to: context-inbox
    label: external edit proof
created_at: 2026-05-22T01:24:43.233Z
updated_at: 2026-05-22T01:25:18.352Z
```
