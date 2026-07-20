# Step 2.4 — Scoring pipeline + feedback

> The Phase 2 payoff: the poller's candidate postings now flow automatically into
> an AI scorer, land as `fit_scores` rows, and ping your phone for the good ones.
> Written for a junior dev coming from Python — every new idea (a DB-as-queue, an
> in-process worker, best-effort side effects) is built up from scratch. By the
> end you should understand how work gets queued and drained without Redis, and
> why the cost ledger is the feature that makes this defensible.

**Deliverable:** enqueue open candidates and drain the queue, and each gets a
real `FitScore` written to the DB, its cost logged to `ai_runs`, and a phone push
for any score ≥ 8:

```bash
pnpm --filter api score:enqueue 10   # queue up to 10 unscored candidates
pnpm --filter api score:drain        # score them all; 8+ buzzes your phone
```

```
poller run ──(new candidates)──▶ enqueueForScoring()  ─┐
admin route / score:enqueue ───────────────────────────┤─▶  scoring_queue (pending rows)
                                                        │
              worker tick / score:drain ─▶ processQueueOnce()
                                                │  per posting:
                                                ├─ scorePosting(id) → FitScore → fit_scores row + ai_runs cost
                                                ├─ score ≥ 8 → ntfy push
                                                └─ mark queue row done / error
```

Files added / changed this step:

```
apps/api/src/
├── db/schema.ts               # + scoring_queue table; + prompt_version/feedback/feedback_note on fit_scores
├── modules/scoring/
│   ├── service.ts             # scorePosting(), recordFeedback(), notifyHighScore()
│   ├── queue.ts               # enqueueForScoring/OpenCandidates, processQueueOnce, worker plugin
│   └── routes.ts              # POST feedback + admin enqueue/drain
├── modules/poller/run.ts      # enqueue new candidates after a poll
├── lib/config.ts              # + SCORING_WORKER_ENABLED
├── scripts/score-{enqueue,drain}.ts
└── server.ts                  # register scoring routes + worker
packages/ai/src/models.ts      # estimateCostUsd now prices dated model snapshots (bug fix)
packages/shared/src/index.ts   # + ScoreFeedbackSchema
drizzle/0003_*.sql             # the migration
```

---

## Part 0 — Vocabulary you need first

- **Job queue:** a list of work items waiting to be processed, decoupled from the
  thing that produces them. The poller *produces* "score this posting" items; the
  worker *consumes* them. Decoupling means a slow scorer never slows the poll.
- **Worker:** a loop that pulls items off the queue and does the work. Ours is an
  in-process `setInterval` — no separate service.
- **Idempotent enqueue:** adding the same posting twice has no extra effect (a
  `UNIQUE` constraint + "do nothing on conflict"). So re-polling can't double-queue.
- **Best-effort side effect:** an action wrapped so its failure can't break the
  main flow (enqueuing after a poll, sending a push). The poll already succeeded;
  a queue hiccup mustn't undo it.
- **Model alias vs snapshot:** you *request* an alias (`claude-haiku-4-5`); the API
  *serves* and reports a dated snapshot (`claude-haiku-4-5-20251001`). They differ,
  and that difference caused a real bug here (Part 5).

---

## Part 1 — Why a database table *is* the queue (`scoring_queue`)

The textbook answer to "I need a job queue" is Redis + BullMQ. We deliberately
don't. For a single-process homelab app, a **plain Postgres table** is the better
call, and the plan says so:

```ts
export const scoringQueue = pgTable("scoring_queue", {
  id: uuid().defaultRandom().primaryKey(),
  jobPostingId: uuid().notNull().unique().references(() => jobPostings.id),
  status: text({ enum: ["pending", "done", "error"] }).notNull().default("pending"),
  attempts: integer().notNull().default(0),
  lastError: text(),
  enqueuedAt: timestamp().notNull().defaultNow(),
  updatedAt: timestamp().notNull().defaultNow(),
});
```

What this buys, versus Redis:

- **Visible.** `select * from scoring_queue;` shows you exactly what's pending,
  done, or errored — in the same psql you already use. A Redis queue is opaque.
- **Restart-safe for free.** Pending rows are just rows; if the process dies
  mid-drain, they're still `pending` when it comes back and get picked up. No
  persistence config, no lost jobs.
- **Zero new infrastructure.** No extra container, no connection, no ops surface.
  The database you already run *is* the queue.

The `UNIQUE(job_posting_id)` is the load-bearing constraint: it makes enqueue
idempotent, so the poller can enqueue every candidate every run and a posting
already in the queue is silently skipped.

> **Interview-ready tradeoff:** *"I used a Postgres table as the job queue instead
> of Redis — for a single-process app it's restart-safe, inspectable in SQL, and
> zero extra infra. I'd reach for Redis/BullMQ only when I need multiple workers
> or high throughput."*

---

## Part 2 — `scorePosting`: one posting → one scored row (`service.ts`)

This is the business logic on top of the step-2.1/2.2 provider. It does five
things in order:

1. **Gather the three prompt inputs** — the posting (joined to its company name),
   the *active* resume text, and the *active* profile version.
2. **Render** the versioned prompt (`renderPrompt(SCORE_JOB_PROMPT, {...})`).
3. **Score** — `provider.complete({ schema: FitScoreSchema, tier: "small" })`.
4. **Log the cost** — `logAiRun("score", result)`.
5. **Insert** the `fit_scores` row, recording the model *and* the prompt version.

The one design subtlety worth understanding is **the Phase-2 fallback**:

```ts
const RESUME_FALLBACK = "(No resume on file yet — Phase 3 adds resume upload...)";
const PROFILE_FALLBACK = "(No ideal-job profile defined yet — Phase 3 adds it...)";
```

The resume and profile *tables* exist (from step 1.1) but are **empty** — building
them is Phase 3 (steps 3.1–3.2). Rather than block scoring on Phase 3, `scorePosting`
uses honest placeholder text when there's no active resume/profile, and stores
`profileVersionId = null`. The score leans on the JD + prefilter signal for now,
and **sharpens automatically** once Phase 3 lands a real profile — at which point
the "re-score open candidates" button re-runs this against the new version. This
is exactly the sequencing the plan intends: the scorer's `{{profile}}` slot is
built in Phase 2, the profile that fills it in Phase 3.

Two smaller things the row records for the future:

- **`promptVersion`** (`"v1"`) — so a later prompt rewrite doesn't make this score
  lie about how it was produced (the payoff of step 2.3).
- **`profileVersionId`** — which profile graded it (null today), so re-scores
  against a new profile are distinguishable.

---

## Part 3 — The worker: drain a few at a time (`queue.ts`)

`processQueueOnce` is the heart of the consumer side. It grabs a small batch of
`pending` rows, oldest first, and scores them **one at a time**:

```ts
for (const item of pending) {
  try {
    const result = await scorePosting(item.jobPostingId);
    await markDone(item.id);
    if (result.score >= HIGH_SCORE) await notifyHighScore(result);   // 8+ → phone
  } catch (err) {
    const attempts = item.attempts + 1;
    await mark(item.id, attempts >= MAX_ATTEMPTS ? "error" : "pending", err);
  }
}
```

The important properties:

- **Sequential, small batches (5) on a timer (20s).** Polite to the API, cheap,
  and dead simple. Throughput isn't the constraint here — you get a handful of new
  candidates per poll, not thousands per second.
- **Failure is contained per-item and bounded.** A posting that fails bumps its
  `attempts`; after `MAX_ATTEMPTS` (3) it's parked as `error` (kept for audit,
  never retried) so one poison posting can't loop forever. A `try/catch` around
  each item means one failure never stalls the rest of the batch.
- **The worker is a Fastify plugin** — same shape as the poll scheduler. Off
  unless `SCORING_WORKER_ENABLED=true`, and it won't even arm without an API key.
  An **overlap guard** (`if (running) return`) makes sure a slow tick never runs
  concurrently with the next timer fire.

`processQueueOnce` is deliberately *the same function* the background worker calls
and the `score:drain` script loops — one code path, two triggers (a timer in prod,
a script for the checkpoint).

---

## Part 4 — Wiring: producer, consumer, and the safety valve

**Producer (the poller).** After a poll, new candidates are enqueued — but as a
*best-effort* side effect:

```ts
if (candidates.length > 0) {
  try { await enqueueForScoring(candidates.map((c) => c.jobPostingId)); }
  catch { /* poll already succeeded — a queue hiccup mustn't fail it */ }
}
```

The poll's real work (fetch, upsert, close, audit) is done; enqueuing is a bonus
step, so it's wrapped to never undo a successful run.

**Two off-by-default flags, same philosophy as Phase 1's `POLL_SCHEDULE_ENABLED`:**
`SCORING_WORKER_ENABLED` keeps the timer from quietly spending money on every
`tsx watch` restart in dev. The manual `score:drain` script works regardless, so
you can score on demand and control exactly when money is spent.

**Bounded admin route.** `POST /api/admin/score-candidates?limit=N` caps at 200,
so a click can't accidentally launch thousands of paid calls. Spend is always
something you opt into a bounded amount of.

---

## Part 5 — A real bug the checkpoint caught: alias vs snapshot pricing

The first smoke run scored fine — but `ai_runs.est_cost` came back **NULL**. The
cause is a subtle one worth remembering:

- We **send** the model alias `claude-haiku-4-5`.
- The API **serves and reports** the dated snapshot `claude-haiku-4-5-20251001`.
- `estimateCostUsd` looked the reported id up in `PRICING` by **exact key** — which
  is keyed by the alias — so it missed, returned `null`, and the ledger stored no
  cost. The one feature the ledger exists for, silently broken.

The fix: match the alias that is a **prefix** of the reported id, robust to the
date suffix changing:

```ts
function priceFor(model: string): Price | null {
  if (PRICING[model]) return PRICING[model];
  for (const [alias, price] of Object.entries(PRICING)) {
    if (model.startsWith(`${alias}-`)) return price;   // "...-4-5-20251001".startsWith("...-4-5-")
  }
  return null;
}
```

After the fix, the same call recorded `est_cost = 0.010181`. There's now a unit
test (`models.test.ts`) pinning this exact case, because it's the sort of bug that
type-checking can't catch and that silently corrupts your data. **Lesson: an
integration checkpoint against the real API surfaces things a unit test of your
own code never would — the snapshot-vs-alias mismatch only exists because the
*server* rewrites your model string.**

---

## Part 6 — How you verify it (the checkpoint)

Needs `ANTHROPIC_API_KEY` (and, for the phone buzz, `NTFY_URL`) in `.env`, and the
DB up (`docker compose up -d db`).

1. **Enqueue and drain:**
   ```bash
   pnpm --filter api score:enqueue 10
   pnpm --filter api score:drain
   ```
   Watch the per-batch summary; `notified(≥8)` counts the phone pushes.
2. **See the scored rows:**
   ```bash
   docker compose exec db psql -U jobber -c \
     "select round(score::numeric,1) score, credential_gap_flag, prompt_version, model_used from fit_scores order by created_at desc limit 10;"
   ```
3. **See the cost ledger (now with real est_cost):**
   ```bash
   docker compose exec db psql -U jobber -c \
     "select feature, model, input_tokens, output_tokens, est_cost, duration_ms from ai_runs where feature='score' order by created_at desc limit 10;"
   ```
4. **Give feedback** on a score (grab an id from step 2), with the API running
   (`pnpm --filter api dev`):
   ```bash
   curl -X POST localhost:3001/api/scores/<id>/feedback \
     -H 'content-type: application/json' -d '{"verdict":"up"}'
   ```
   → `{"ok":true}`, and the `feedback` column on that row flips to `up`.

The plan's checkpoint is the automated version: with `POLL_SCHEDULE_ENABLED` and
`SCORING_WORKER_ENABLED` both on, a morning poll enqueues candidates, the worker
scores them, and an 8+ pings your phone before you've opened the dashboard.

---

## What's next — Step 2.5 (the triage page), and Phase 2 done

Step 2.5 surfaces all of this in the UI: a `/triage` page of score-sorted cards
(score badge, match points, gaps, credential-flag icon, a rationale expander),
per-card actions (open URL / mark applied / dismiss / 👍👎 wired to the feedback
endpoint from this step), and a small "AI spend this month" stat summing
`ai_runs.est_cost` — the cost-awareness story made visible daily. That's the
portfolio-demo moment, and the end of Phase 2.
