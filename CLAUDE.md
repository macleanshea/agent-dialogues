# Agent Dialogues: instructions for Claude Code sessions

@AGENTS.md

## Rules for every session

1. **Read `docs/SPEC.md` first**, all of it, including the Decisions log at the end, before planning or writing code.
2. **Do only the PR you are asked for.** The spec's "Build plan" splits the work into five PRs. Build what your PR lists and nothing from later PRs. If your PR needs a small piece of groundwork, keep it minimal and log it.
3. **Build nothing listed under "Not in v1"** in the spec.
4. **Check current docs for every API the spec names** (Anthropic Messages API, thinking, effort, prompt caching, rate limits, Vercel Workflow, Neon) before writing code against it. Don't rely on memory: these APIs changed recently. Next.js also ships its own docs in `node_modules/next/dist/docs/` (see AGENTS.md).
5. **Record every deviation from the spec** in the "Decisions log" section at the end of `docs/SPEC.md`. That includes anything the spec left open that you had to decide. Add entries under a heading for your PR. Do not edit the rest of the spec.

## Working with the user

- The user is a product manager. They do not review code. They check work by clicking through the Vercel preview link.
- Every PR needs tests that run in CI.
- Every PR description has: (a) a plain-language summary of what changed, (b) the decisions you made that the spec did not specify, and (c) a numbered click-through checklist for the preview link.
- If something needs the user to act in a dashboard (Vercel, Neon, Claude Console), stop and say exactly what to click.
- Explain things without assuming they know library names.

## Project map

- `src/lib/models.ts`: model IDs and prices (the one config file for both).
- `src/lib/config.ts`: run settings, defaults, limits, and validation.
- `src/lib/engine/`: the conversation engine (history building, one turn per call, stop rules, the Mock model, the Anthropic client).
- `src/lib/db/`: database schema (`schema.ts`), connection, and migrations runner. SQL migrations live in `drizzle/`.
- `src/lib/fields/library.ts`: the predefined analysis fields, seeded into the database.
- `src/lib/runs/service.ts`: creating runs, and the page queries.
- `src/lib/runs/execution.ts`: executing runs one model call at a time (cost ceiling, Stop, finishing). `src/workflows/run.ts`: the Vercel Workflow that calls it.
- `src/lib/analysis/`: PR 3 analysis. `prompts.ts` holds every analysis prompt; `fields.ts` is the one code path per field type (prompt text, JSON schema, storage, aggregation); `measures.ts` the computed measures; `service.ts` coding, the run report, and re-analysis; `citations.ts` the citation check; `judge.ts` the summarizer/report model client and the Mock judge. `src/workflows/analysis.ts` runs it.
- `src/app/`: pages. `src/components/ui/`: the small component library.
- `tests/unit/`: unit and database tests (Vitest). `tests/e2e/`: click-through tests (Playwright).

## Commands

- `npm run dev`: local app. Without `DATABASE_URL` it uses a local in-process Postgres (PGlite) stored in `.pglite/`.
- `npm test`: unit and database tests. `npm run typecheck`, `npm run lint`.
- `npm run build && npm run test:e2e`: production build, then browser tests.
- After changing `src/lib/db/schema.ts`: `npm run db:generate` to create a migration, and commit the new files in `drizzle/`. Migrations apply automatically during the Vercel build.

Tests must never need secrets or the network: use the Mock model and PGlite.
