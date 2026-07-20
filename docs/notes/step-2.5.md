# Step 2.5 — The triage page (Phase 2 done)

> The portfolio-demo moment: everything Phase 2 built — scored postings, the cost
> ledger, the feedback loop — surfaced on one page you'd actually use each morning.
> Written for a junior dev coming from Python: the frontend patterns (query +
> mutation + invalidation) were introduced in step 1.7, so this note focuses on
> what's *new* here — an anti-join in SQL, per-row mutation state, and a
> deliberately tiny "expander" with no library. By the end you should see how the
> whole phase composes into a product surface.

**Deliverable:** a `/triage` page (now the app's landing view) showing score-sorted
cards — score badge, match points, gaps, credential-gap flag, a rationale
expander — with per-card actions (open, mark applied, dismiss, 👍/👎) and a running
"AI spend this month" stat in the corner.

```
GET /api/triage        ─▶ score-sorted cards            ┐
GET /api/stats/ai-spend ─▶ "$0.01 · 2026-07 · 4 runs"   │  TanStack Query (read)
                                                         │
card actions ─▶ POST /api/scores/:id/feedback  (👍/👎)   ┐
             ─▶ POST /api/scores/:id/dismiss            │  useMutation → invalidate ["triage"]
             ─▶ POST /api/applications (mark applied)   ┘  (also invalidates ["applications"])
```

Files added / changed this step:

```
apps/api/src/
├── db/schema.ts                 # + dismissed boolean on fit_scores (migration 0004)
├── modules/scoring/triage.ts    # listTriage(), dismissScore(), aiSpendThisMonth()
└── modules/scoring/routes.ts    # + GET /api/triage, GET /api/stats/ai-spend, POST .../dismiss
packages/shared/src/index.ts     # + TriageItemSchema, AiSpendSchema
apps/web/src/
├── pages/TriagePage.tsx         # the page
├── App.tsx                      # + /triage route; index now redirects here
└── components/Layout.tsx        # + Triage nav (first)
```

---

## Part 0 — Vocabulary you need first

- **Anti-join:** a query that keeps rows from table A that have **no** match in
  table B. In SQL: `LEFT JOIN B ... WHERE B.id IS NULL`. We use it to drop postings
  you've already applied to.
- **Derived filter vs stored flag:** "already applied" is *derived* (it's true iff
  an application row exists — no column needed). "Dismissed" is a *stored flag* (a
  boolean column) because there's no other row that records it. Knowing which is
  which avoids adding columns you don't need.
- **Mutation variables:** the argument you pass to `mutation.mutate(x)`. TanStack
  Query exposes the in-flight one as `mutation.variables`, which lets you tell
  *which* row is currently mutating.
- **`<details>`/`<summary>`:** native HTML for a collapsible section — a zero-JS,
  zero-library expander. The browser handles the open/close state.

---

## Part 1 — The triage query: filter in SQL, render dumb (`triage.ts`)

`listTriage()` is the one bit of real logic. The page should be a dumb renderer,
so *all* the "what's worth showing" decisions live in one SQL statement:

```ts
db.select({ /* score + posting + company fields */ })
  .from(fitScores)
  .innerJoin(jobPostings, eq(fitScores.jobPostingId, jobPostings.id))
  .innerJoin(companies,   eq(jobPostings.companyId, companies.id))
  .leftJoin(applications, eq(applications.jobPostingId, jobPostings.id))  // ← anti-join
  .where(and(
    eq(fitScores.dismissed, false),   // not dismissed
    eq(jobPostings.status, "open"),   // still open
    isNull(applications.id),          // ← not yet applied to
  ))
  .orderBy(desc(fitScores.score), desc(fitScores.createdAt))
  .limit(100);
```

Two things worth understanding:

- **The anti-join (`leftJoin` + `isNull`).** A `LEFT JOIN` keeps every score row
  even when no application matches; the `WHERE applications.id IS NULL` then keeps
  *only* the ones with no match. That's "scores for postings I haven't applied to"
  in one join, no subquery. "Mark applied" (which creates an application) makes a
  card vanish from triage automatically — no extra bookkeeping.
- **Why `dismissed` is a column but "applied" isn't.** Being applied-to is already
  recorded by the existence of an application row, so we *derive* it. Being
  dismissed has no other home, so it needs a stored boolean. Add state only when
  nothing existing already implies it.

The `aiSpendThisMonth()` query is your first taste of aggregate SQL that Phase 4
leans on heavily:

```ts
sql`coalesce(sum(${aiRuns.estCost}), 0)`   // sum the money, NULLs → 0
sql`${aiRuns.createdAt} >= date_trunc('month', now())`   // this calendar month
```

`est_cost` is a `numeric` column, so `sum()` comes back as a **string** (exact
money, no float drift) — we `Number()` it at the very end, after the arithmetic is
done in the database.

---

## Part 2 — The page: read, then mutate (`TriagePage.tsx`)

The read side is two `useQuery` calls (the list and the spend stat), exactly the
pattern from step 1.7. The write side is three `useMutation`s — feedback, dismiss,
mark-applied — and the thing tying them together is **invalidation**:

```ts
const invalidateTriage = () => queryClient.invalidateQueries({ queryKey: ["triage"] });
// every mutation's onSuccess calls this → the list refetches → the UI reconciles
```

- **👍/👎** posts to the feedback endpoint from step 2.4, then invalidates so the
  button reflects the new state (verified live: clicking 👍 wrote `feedback='up'`
  to the DB and the button flipped to filled).
- **Dismiss** flips the `dismissed` flag; the refetched list no longer includes it.
- **Mark applied** creates a linked application (`jobPostingId` + `companyId`), so
  the anti-join drops it from triage *and* it appears in the Pipeline page — which
  is why this mutation invalidates **both** `["triage"]` and `["applications"]`.
  One click updates two pages, with no shared state between them.

### 2.5a Per-row mutation state (the one genuinely new frontend idea)

A list has many cards but one `feedback` mutation object. If we disabled buttons on
`feedback.isPending`, *every* card's buttons would grey out when you click one. The
fix is `mutation.variables` — the args of the in-flight call — so we disable only
the row being acted on:

```ts
const busy = (id: string) =>
  (feedback.isPending   && feedback.variables?.id     === id) ||
  (dismiss.isPending    && dismiss.variables          === id) ||
  (markApplied.isPending && markApplied.variables?.scoreId === id);
```

`busy(item.scoreId)` gates just that card's buttons. This is the clean way to run
one mutation hook across a list without a spinner storm.

### 2.5b The rationale expander is just HTML

The "Why this score" toggle is a native `<details><summary>`:

```tsx
<details>
  <summary className="cursor-pointer ...">Why this score</summary>
  <p>{item.rationale}</p>
</details>
```

No state, no library, no `useState`. When the platform already does the job
(open/close is built into the element), reaching for React state would be strictly
more code and more bugs. Knowing when *not* to add machinery is a real skill.

---

## Part 3 — The AI-spend stat: the cost story, made daily

A small box in the header renders `aiSpendThisMonth()`:

```tsx
${spend.data.totalUsd.toFixed(2)}   ·   AI spend · {month} · {runs} runs
```

It's tiny on purpose, but it's the point of the whole `ai_runs` ledger: the cost of
running an LLM over your job search is *visible every time you open the app*, not
buried in a bill at month end. That "I was cost-aware, and here's the receipt"
story is exactly the kind of thing an interviewer remembers.

---

## Part 4 — How you verify it (the checkpoint)

With scored postings in the DB (`score:enqueue` + `score:drain` from step 2.4) and
both dev servers running (`pnpm dev` at the root):

1. Open <http://localhost:5173/triage> — cards appear score-sorted, best first,
   with the AI-spend stat in the corner.
2. Expand "Why this score" on a card; read the rationale.
3. Click 👍 — the button fills in and the verdict persists (check with
   `select feedback from fit_scores where id='…'`).
4. Click **Mark applied** on a card — it disappears from triage and shows up on the
   **Pipeline** page (one action, two pages updated via invalidation).
5. Click **Dismiss** on another — it vanishes and won't come back.

That's the checkpoint: *you triaged real scored postings from the browser, and the
cost of scoring them was staring back at you the whole time.* **Phase 2 is done.**

---

## What's next — Phase 3

The AI layer is built and demoable. Phase 3 fills the two placeholders scoring
currently falls back on — the **Ideal Job Profile** (step 3.1, which makes
`{{profile}}` real and adds a "re-score against the new profile" button) and
**resume versions** (step 3.2, `{{resume}}`) — then adds the alternate providers
(CLI and Cowork, step 3.3) so the exact same scoring can run without an API key or
per-call billing. See `phase-2.md` for the wrap-up.
