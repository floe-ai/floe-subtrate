# Issue #15 live QA evidence

Live QA ran against a temporary real bus on `127.0.0.1:5477` and FloeWeb on `127.0.0.1:5478`.

- `seed.json` records the workspace, two real conversations, and context ids seeded through the bus API.
- `live-qa-summary.json` records Escape, backdrop, Cancel, keyboard focus, native-dialog, and confirmed-delete checkpoints.
- Screenshots `01` through `05` show the app dialog open, focus trap proof, focus return after Cancel, pre-delete confirmation, and the remaining conversation after confirmed deletion.
