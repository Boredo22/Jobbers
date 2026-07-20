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
| 2.4 | Scoring pipeline + feedback (queue, worker, ntfy) | `modules/scoring/*`, `scoring_queue` table, `POST /api/scores/:id/feedback` | ✅ built — see [step-2.4.md](step-2.4.md) |
| 2.5 | Triage page (sorted cards, 👍/👎, AI-spend stat) | `/triage` route, `modules/scoring/triage.ts` | ✅ built — see [step-2.5.md](step-2.5.md) |

Steps 2.1–2.3 are the **foundation**: a swappable AI abstraction, one concrete
backend that guarantees schema-shaped output, and a versioned prompt. Steps 2.4–2.5
are the **payoff**: wiring that foundation into the poller and surfacing scores in
the UI. **All five are built.**

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

## Phase 2 — complete ✅

End to end, twice a day Jobber now: polls ~68 boards → flags candidates →
**enqueues them for scoring** → an in-process worker (or the `score:drain` script)
sends each to a model, gets a calibrated `FitScore`, writes it, and logs the cost →
pushes your phone for anything ≥ 8 → and surfaces the lot on a `/triage` page where
you open / apply / dismiss / 👍👎, with the month's AI spend staring back at you.

| Step | What | Note |
|---|---|---|
| 2.1 | Provider interface | [step-2.1.md](step-2.1.md) |
| 2.2 | ApiProvider (Mode A) — forced structured output | [step-2.2.md](step-2.2.md) |
| 2.3 | Versioned prompt files + first unit test | [step-2.3.md](step-2.3.md) |
| 2.4 | Scoring pipeline: queue, worker, feedback, ntfy | [step-2.4.md](step-2.4.md) |
| 2.5 | Triage page + AI-spend stat | [step-2.5.md](step-2.5.md) |

**The through-lines worth remembering from Phase 2:**
- *Dependency inversion* — a pure `@jobber/ai` library behind one interface; the
  app supplies env, DB, and cost table. Three backends, zero caller changes.
- *Validate at every edge, including the model* — forced tool use + `safeParse` +
  one retry; an LLM that returns the wrong shape is a caught error, not a bad row.
- *Push volatile facts to one edge* — model IDs/prices, env, the prompt text each
  live in exactly one file.
- *Filter where the data is* — the triage anti-join does its selection in SQL so
  the page just renders; the cost ledger sums in the database.
- *Every call is metered* — `ai_runs` turns "I used an LLM" into "here's the
  receipt, to the cent," visible daily.

**One bug this phase is worth remembering:** the ledger silently stored `NULL`
`est_cost` because we price by alias (`claude-haiku-4-5`) but the API reports a
dated snapshot (`claude-haiku-4-5-20251001`). Prefix-matching fixed it, and a unit
test pins it. It only surfaced because we ran the *real* API — the server rewrote
our model string in a way no unit test of our own code would have shown.

**What's next — Phase 3:** fill the two placeholders the scorer falls back on today
— the **Ideal Job Profile** (3.1) and **resume versions** (3.2) — then the alternate
**CLI and Cowork providers** (3.3) so the same scoring runs with no API key or
per-call billing. The `{{profile}}`/`{{resume}}` slots are already waiting for them.
