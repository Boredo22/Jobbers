# Phase 2 — The AI layer + fit scorer: study notes

> The section overview. Phase 2 gives Jobber judgment: it reads a posting and an
> LLM scores how well it fits *you*, with the cost of every call recorded. This
> note ties the steps together and defines the vocabulary once; each step keeps
> its own deep-dive note (`step-2.1.md` … `step-2.5.md`) for the line-by-line.
> Written for a junior dev coming from Python — jargon gets defined the first time
> it appears, and the *why* matters as much as the *how*.

**Where the phase is headed:** twice-daily the poller already finds new candidate
postings (Phase 1). Phase 2 sends each one to a model, gets back a calibrated
`FitScore` (0–10, match points, gaps, credential-gap flag, rationale), stores it,
and pings your phone for anything ≥ 8 — so the best roles surface *before* you open
the dashboard. Every model call lands one row in an `ai_runs` cost ledger.

```
poller finds a candidate posting
      │
      ▼
scorePosting(id)  ── assemble JD + active resume + active profile
      │                       │
      │              renderPrompt(score-job.v1.md, {jd, resume, profile})   ← step 2.3
      ▼                       │
provider.complete({ schema: FitScoreSchema })   ← steps 2.1 (interface) + 2.2 (Mode A)
      │  forced tool use → safeParse → retry once
      ▼
insert fit_scores row (score, model, prompt version)   ← step 2.4
      │
      ├─ score ≥ 8 → ntfy push
      └─ /triage page: sorted cards + 👍/👎 feedback   ← step 2.5
```

---

## The five steps at a glance

| Step | What | Key artifact | Status |
|---|---|---|---|
| 2.1 | `packages/ai` scaffold + provider **interface** | `provider.ts` (`AIProvider`, `AIRequest`, `AIResult`, `ModelTier`) | ✅ built — see [step-2.1.md](step-2.1.md) |
| 2.2 | `ApiProvider` (Mode A) — forced structured output | `providers/api.ts`, `models.ts`, shared `FitScoreSchema`, api `lib/ai.ts`, `ai_runs` ledger | ✅ built — see [step-2.2.md](step-2.2.md) |
| 2.3 | Prompts as **versioned files** + first unit test | `prompts/score-job.v1.md`, `prompts.ts`, `prompts.test.ts` (Vitest) | ✅ built — see [step-2.3.md](step-2.3.md) |
| 2.4 | Scoring pipeline + feedback (queue, worker, ntfy) | `modules/scoring/*`, `scoring_queue` table, `POST /api/scores/:id/feedback` | ⏳ next |
| 2.5 | Triage page (sorted cards, 👍/👎, AI-spend stat) | `/triage` route in `apps/web` | ⏳ upcoming |

Steps 2.1–2.3 are the **foundation**: a swappable AI abstraction, one concrete
backend that guarantees schema-shaped output, and a versioned prompt. Steps 2.4–2.5
are the **payoff**: wiring that foundation into the poller and surfacing scores in
the UI.

---

## Part 0 — Vocabulary you need first

- **Provider / provider interface:** the one contract every AI backend implements
  (`complete(prompt, schema) → validated value`). Callers depend on the *interface*,
  never a concrete backend — so switching from the API to the CLI (Phase 3) is a
  config change, not a code change. (Python analog: a `typing.Protocol`.)
- **Tier (`small` / `large`):** intent, not a model name. Callers say "this is
  cheap bulk work" (`small`) or "this is quality-critical" (`large`); one config
  file maps tiers → concrete model IDs, so a model rename is a one-line edit.
- **Forced tool use:** the reliable way to make an LLM return structured data.
  Declare one "tool" whose input schema is your Zod schema, *force* the model to
  call it, and read the schema-shaped arguments back. (Step 2.2 builds this.)
- **`FitScore`:** the model's verdict — `score` (0–10), `matchPoints`, `gaps`,
  `credentialGapFlag`, `rationale`. A Zod schema in `@jobber/shared`; the model's
  output contract *and* the shape of a `fit_scores` row.
- **`ai_runs` (the cost ledger):** an append-only table, one row per model call —
  feature, model, tokens in/out, estimated USD, duration. The project's
  "I was cost-aware" evidence, visible as a running total in the UI (step 2.5).
- **Prompt versioning:** each prompt iteration is a frozen file (`score-job.v1.md`),
  and the version tag rides on every score — so rewriting the prompt never makes
  old scores lie about how they were graded.
- **Token:** the unit models bill in (~¾ of a word). Cost = tokens × price-per-
  million, looked up per model in `models.ts`.

---

## The three through-lines so far

These are the ideas Phase 2 keeps leaning on — worth being able to state cold:

- **Dependency inversion (the whole shape of the layer).** `packages/ai` is a pure,
  env-agnostic, DB-agnostic library: it knows how to call a model, nothing about
  *this* app. The volatile stuff — env vars, the database, the price table — lives
  app-side in `apps/api/src/lib/ai.ts`. That split is what lets the same interface
  serve three backends (API now; CLI + Cowork in Phase 3) with no caller changes.
- **Validate at every edge (CLAUDE.md §4), including the model.** An LLM's output is
  external input, so it crosses a Zod boundary like everything else: forced tool
  use *plus* a `safeParse` and one retry. A model that returns `score: 11` is a
  loud, caught error — never a silently bad row.
- **Push volatile facts to one edge.** Model IDs and prices (`models.ts`), the env
  gateway (`config.ts`), the prompt text (`score-job.v1.md`) — each lives in exactly
  one place, so a rename/reprice/reword is a one-file edit that no call site feels.
  Same instinct that made the poller's config and the shared schemas single-source.

---

## What Jobber can do now (end of 2.3)

Run `pnpm --filter api score:one` (with an `ANTHROPIC_API_KEY` set) and Jobber will
take a real job description + a candidate profile/resume, render the versioned
scoring prompt, force a live model to return a calibrated `FitScore`, validate it,
print it, and record the call's cost in `ai_runs`. The abstraction, the reliable
structured-output path, the cost ledger, and the versioned prompt are all in place
and unit-tested where it pays (prompt rendering). What's missing is the *automation*
— scoring every new candidate the poller finds, and showing the results — which is
exactly steps 2.4 and 2.5.

---

## What's next

- **Step 2.4** wires the foundation into the poller: a `scorePosting(id)` that
  assembles the *active* resume + *active* profile version, a `scoring_queue` table
  drained by an in-process `setInterval` worker, ntfy firing for scores ≥ 8, and a
  feedback endpoint. Needs a small Drizzle migration (`scoring_queue` table,
  `prompt_version` column on `fit_scores`).
- **Step 2.5** adds the `/triage` page and the visible "AI spend this month" stat —
  the portfolio-demo moment. **Phase 2 done.**

This note gets a closing "Phase 2 complete" section once 2.5 lands.
