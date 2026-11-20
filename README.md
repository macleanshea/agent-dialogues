# agent-dialogues
Run conversations between two Claude models, summarize each one, and compare runs across experiments.

The product spec is in [docs/SPEC.md](docs/SPEC.md). Notes for Claude Code sessions are in [CLAUDE.md](CLAUDE.md).

## Local development

```bash
npm install
npm run dev
```

Without `DATABASE_URL`, the app uses a local in-process Postgres stored in `.pglite/`. Delete that folder to start fresh.

## Tests

```bash
npm test
npm run build && npm run test:e2e
```
