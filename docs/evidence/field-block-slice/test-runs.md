# Automated preflight and regression runs

Live pass git SHA: `162f03fd949b75869d53e880ac965f3bc293ef0f`

Preflight after fixing the root vertical template-init blocker:

| Command | Result |
| --- | --- |
| `npm test` | passed |
| `npm test --workspace floe-bridge` | passed |
| `npm test --workspace floe-bus` | passed |
| `npm run test --workspace floe-web` | passed on clean rerun; one earlier parallel run hit a React Flow handle-drag timeout that passed when isolated |
| `npm run build` | passed |

Focused proof checks after the blocker fix:

| Check | Result |
| --- | --- |
| Partial `.floe\fields` probe creates missing `.floe\agents\floe.md` | passed |
| `npx vitest run src\vertical-slice.test.ts -t "initializes .floe"` from `tests` | passed |
| Isolated FloeWeb React Flow handle-drag Field Connection test | passed |
