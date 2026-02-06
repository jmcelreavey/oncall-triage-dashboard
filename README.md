# Oncall Triage Dashboard (V2 Scaffold)

A local, self-contained dashboard + scheduler that watches Datadog, launches an OpenCode/Codex triage session, and stores the report in SQLite for review.

**Goals baked into the scaffold**
- Prompt-first triage: the agent is instructed to use `git`, `rg`, `kubectl`, GitHub, and Confluence instead of relying on precomputed Python.
- Evidence-based output: the report must cite JSON fields and the command results the agent gathered.
- Local + safe: nothing is pushed or PR'd unless you ask.

## What’s included

- **Next.js dashboard** (`apps/web`) with a clean status UI and report viewer.
- **NestJS API + scheduler** (`apps/api`) with a 1‑minute cron.
- **Prisma + SQLite** for local persistence.
- **OpenCode provider** (default) with session ID + URL support.
- **Session continuation** button to re-run a triage based on the last report.
- **Optional GitHub + Confluence enrichment** stored alongside alerts for extra context.
- **Codex provider** (CLI runner) behind `PROVIDER=codex`, including deep-link opener.
- **Integration checks** for Datadog, GitHub, Confluence.
- **Skills context builder** to feed your existing Codex skills into the prompt.
- **Connection wizard** UI to configure tokens and validate access.
- **Branch suggestion** button that proposes a fix-branch name based on the report.
- **Business Insider-inspired light/dark theme** with a quick toggle.
- **Evidence gatherer pipeline** (git history, repo diffs, K8s live state, Datadog logs, runbooks, Jira/Confluence).
- **Per-service heuristics registry** (`apps/api/config/heuristics.yaml`) for known failure patterns.
- **Similar incident surfacing** with confidence + timeline.
- **Scheduler health endpoint** with freshness checks.
- **Scheduler lock + lease + catch-up** to prevent overlaps and recover missed intervals.
- **GitHub PR context** for recent config changes.
- **K8s resource graph** (workload → HPA → PDB → pods/events) in evidence bundle.
- **Fix diff viewer** with Copy Patch + Open File actions.

## Quick Start

> Recommended Node.js version: 20.x (see `.nvmrc`; Prisma can be flaky on bleeding-edge Node versions).

1. Install deps:

```bash
npm install
```

2. Create your `.env` from the example:

```bash
cp .env.example .env
```

Also create the API-only `.env` for Prisma:

```bash
cp apps/api/.env.example apps/api/.env
```

3. (Optional) Generate skills context:

```bash
node scripts/build-skills-context.mjs
```

4. Initialize the database:

```bash
npm run db:push
```

If Prisma complains about a missing SQLite file, the dev script creates it automatically using `sqlite3 dev.db "VACUUM;"`.

5. Run dev:

```bash
npm run dev
```

- Web: `http://localhost:3000`
- API: `http://localhost:4000`

To enable session deep links, run:

```bash
opencode serve --port 4096
```

## How triage works

1. Scheduler polls Datadog every minute.
2. New alerts are saved as `AlertEvent`.
3. The triage provider is invoked with:
   - `prompt.txt` (strict instructions to use local tools + skills)
   - `alert.json` (alert context)
   - `skills_context.md` (optional)
4. The report is stored in SQLite and shown in the dashboard.

`npm run dev` also:
- Syncs `.env` from your `.zshrc`
- Generates `skills_context.md`
- Ensures the SQLite DB exists via Prisma
- Starts OpenCode server if `OPENCODE_WEB_URL` is set

## Environment config

See `.env.example` for all variables. The most important:

- `DATADOG_API_KEY`, `DATADOG_APP_KEY`
- `ALERT_TEAM` (optional; filter Datadog monitors by `team:<value>` tag)
- `REPO_ROOT` (optional; defaults to the project root)
- `PROVIDER=opencode` (default)
- `REPO_SCAN_COMMITS` (default 20)
- `TRIAGE_STALE_THRESHOLD_MS` (default 2x interval)
- `TRIAGE_LEASE_MS` (default 2x interval)
- `TRIAGE_MAX_CATCHUP` (default 5)
- `DATADOG_TIMEOUT_MS` (default 20000)
- `TRIAGE_RUN_TIMEOUT_MS` (default 720000)
- `OPENCODE_MODEL` (optional; omit to use OpenCode defaults)
- `OPENCODE_VARIANT` (optional; omit to use OpenCode defaults)
- `OPENCODE_WEB_URL=http://127.0.0.1:4096`
- `TRIAGE_INTERVAL_MS=60000`
- Prisma 7 uses `apps/api/prisma.config.ts` for datasource config.

## API endpoints

- `GET /health`
- `GET /integrations`
- `POST /integrations/test` with `{ "name": "datadog" | "github" | "confluence" | "opencode" }`
- `POST /integrations/configure` to update local `.env` files
- `POST /triage/run` to trigger manual run
- `POST /triage/continue/:id` to continue a report
- `POST /triage/open-codex/:id` to open a Codex session
- `POST /triage/suggest-branch/:id` to generate a branch suggestion
- `GET /reports`
- `GET /reports/:id`

## Notes

- The OpenCode provider uses `opencode run --format json` and parses the assistant response. If OpenCode output format changes, we can update the parser.
- Codex provider is wired via CLI; set `PROVIDER=codex` and `CODEX_BIN`.
- The report format is enforced in the prompt. If you want more structured output, we can convert it to JSON and render specific sections.

## Tests

```bash
npm --workspace apps/api test
npm run test:e2e
```

Unit tests cover core parsing utilities (alert parsing + evidence helpers). Evidence helpers are exported for tests only.

Note: `npm run test:e2e` starts its own web+api servers with an isolated SQLite DB. Stop any running dev servers first so ports 3000/4000 are free.

## Next steps (when you’re ready)

1. Add Slack ingestion + webhook receiver (optional).
2. Ship an Electron wrapper if you want a desktop bundle.
