# Bus event excerpts

The bus does not log broadcast payloads to Fastify stdout; this file preserves raw JSON messages captured from the real `/v1/events/stream` WebSocket during the live pass. Timestamps are the bus event timestamps.

```jsonl
{"type":"field.upserted","payload":{"workspace_id":"workspace:317635fab942b83a","field_id":"inbound-pr-review","source":"api","changed":"semantic"},"at":"2026-05-22T01:24:43.241Z"}
{"type":"field.upserted","payload":{"workspace_id":"workspace:317635fab942b83a","field_id":"inbound-pr-review","source":"watcher","changed":"semantic"},"at":"2026-05-22T01:24:43.392Z"}
{"type":"field.upserted","payload":{"workspace_id":"workspace:317635fab942b83a","field_id":"inbound-pr-review","source":"api","changed":"semantic"},"at":"2026-05-22T01:24:43.885Z"}
{"type":"field.upserted","payload":{"workspace_id":"workspace:317635fab942b83a","field_id":"inbound-pr-review","source":"watcher","changed":"semantic"},"at":"2026-05-22T01:24:44.034Z"}
{"type":"field.upserted","payload":{"workspace_id":"workspace:317635fab942b83a","field_id":"inbound-pr-review","source":"api","changed":"layout","renderer":"floeweb"},"at":"2026-05-22T01:24:44.489Z"}
{"type":"field.upserted","payload":{"workspace_id":"workspace:317635fab942b83a","field_id":"inbound-pr-review","source":"watcher","changed":"layout","renderer":"floeweb"},"at":"2026-05-22T01:24:44.642Z"}
{"type":"field.upserted","payload":{"workspace_id":"workspace:317635fab942b83a","field_id":"inbound-pr-review","source":"watcher","changed":"semantic"},"at":"2026-05-22T01:25:15.199Z"}
{"type":"field.upserted","payload":{"workspace_id":"workspace:317635fab942b83a","field_id":"inbound-pr-review","source":"api","changed":"layout","renderer":"floeweb"},"at":"2026-05-22T01:25:15.517Z"}
{"type":"field.upserted","payload":{"workspace_id":"workspace:317635fab942b83a","field_id":"inbound-pr-review","source":"watcher","changed":"layout","renderer":"floeweb"},"at":"2026-05-22T01:25:15.675Z"}
{"type":"field.upserted","payload":{"workspace_id":"workspace:317635fab942b83a","field_id":"inbound-pr-review","source":"watcher","changed":"semantic"},"at":"2026-05-22T01:25:18.516Z"}
```

Related daemon logs were captured in the session-only live QA directory and were not committed because they include local absolute paths and runtime noise.
