# Jobber — instructions for Claude Code

Self-hosted job-search dashboard. **Stack:** pnpm monorepo — React 19 + Vite + Tailwind/shadcn (`apps/web`), Fastify + TypeScript (`apps/api`), Postgres 16 + Drizzle (`docker compose` service `db`), shared Zod schemas (`packages/shared`), pluggable AI provider layer (`packages/ai`). Runs on a home LAN via Docker Compose.

## The plan is the source of truth

- `docs/PLAN.md` — architecture, features, and the *why* behind every choice.
- `docs/IMPLEMENTATION.md` — the step-by-step build order. **Work one step at a time, in order.** Do not jump ahead or batch multiple steps unless asked.
- Where the plan names a library, install current stable and follow its official docs if syntax differs from the plan's sketches — sketches show intent, docs win.

## Teaching mode (important)

The owner is learning TS/React/Node coming from Python (Flask/FastAPI). After implementing each step:
1. Explain the new concepts it introduced (compare to Python equivalents where apt).
2. Point out the 2–3 lines most worth understanding deeply.
3. Wait for the go-ahead before starting the next step.
The goal is that the owner could re-implement and defend every piece in an interview.

## Conventions (non-negotiable)

- Strict TypeScript everywhere; `any` requires a stated justification.
- Every external input crosses a Zod boundary: ATS responses, request bodies, LLM outputs, queue files.
- Biome for lint/format — `pnpm biome check --write .` must be clean before committing.
- Vitest tests where they pay rent: normalizers, prefilter, prompt rendering, upsert/close logic.
- Secrets only in `.env` (gitignored; keep `.env.example` current). The Anthropic key never reaches frontend code.
- Commit per completed step: `phaseN: <what> (step N.M)`. Do not commit with failing typecheck.
- AI drafts, human finishes: anything user-facing that leaves the machine (outreach notes, tailored resume text) is generated as a draft only — never auto-sent.

## Checkpoints

Each step in docs/IMPLEMENTATION.md ends with a ✅ Checkpoint. After implementing, state exactly how to run the checkpoint — the owner verifies it themselves before you proceed.
