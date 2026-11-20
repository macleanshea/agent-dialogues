# agent-dialogues
Run conversations between two Claude models, summarize each one, and compare runs across experiments.

The product spec is in [docs/SPEC.md](docs/SPEC.md). Notes for Claude Code sessions are in [CLAUDE.md](CLAUDE.md).

## Local development

```bash
npm install
npm run dev
```

Without `DATABASE_URL`, the app uses a local in-process Postgres stored in `.pglite/`. Delete that folder to start fresh.

Runs execute in the background with Vercel Workflow. Locally, Workflow keeps its own state in `.workflow-data/`; `npx workflow web` shows the local runs. The Mock model needs nothing else. To use real models locally, set `ANTHROPIC_API_KEY`.

## Tests

```bash
npm test
npm run build && npm run test:e2e
```
