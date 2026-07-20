# Step 3.1 — The Ideal Job Profile

> Phase 3 begins by closing Phase 2's biggest loose end: the scorer had a
> `{{profile}}` slot but nothing to put in it. This step lets you build that
> profile — AI drafts one from your notes, you edit it, save it as a version, and
> re-score against it. Written for a junior dev coming from Python: new ideas
> (nested schemas through forced tool use, a "propose then edit" AI pattern,
> append-only versioning, latest-row dedup) are built up from scratch. By the end
> you should understand how a human-in-the-loop AI feature is structured so the
> model drafts but the human decides.

**Deliverable:** a `/profile` page where "✨ Propose with AI" fills a form from your
notes + resume + application history; you edit it; **Save** creates a
`profile_versions` row and makes it active; **Re-score open candidates** re-queues
already-scored postings so a drain grades them against the new profile.

```
notes + resume + application history
        │
POST /api/profile/propose ─▶ provider.complete({ schema: IdealJobProfileSchema, tier: "large" })
        │                            (forced tool use fills nested hardFilters + criteria[])
        ▼
   editable form ──edit──▶ POST /api/profile ─▶ new profile_versions row (active)
                                                       │
                              POST /api/profile/rescore ─▶ reset scoring_queue → pending
                                                       │
                              score:drain ─▶ new fit_scores rows (profileVersionId set) ─▶ triage (latest per posting)
```

Files added / changed this step:

```
packages/shared/src/index.ts        # IdealJobProfile/HardFilters/Criterion/ProfileVersion/ProfilePropose
packages/ai/prompts/propose-profile.v1.md + prompts.ts   # the propose prompt
apps/api/src/modules/profile/
├── service.ts                      # proposeProfile (AI), getActiveProfile, saveProfile
└── routes.ts                       # GET/POST /api/profile, /propose, /rescore
apps/api/src/modules/scoring/
├── queue.ts                        # + rescoreOpenScored()
└── triage.ts                       # + latest-score-per-posting dedup
apps/web/src/pages/ProfilePage.tsx  # the page  (+ route + nav)
```

---

## Part 0 — Vocabulary you need first

- **Human-in-the-loop AI:** the model *proposes*, the human *disposes*. The AI
  output is a starting draft you edit, never something auto-committed. The house
  rule "AI drafts, human finishes" (CLAUDE.md) made concrete.
- **Nested schema:** a Zod object with an object and an array of objects inside it
  (here: `hardFilters` + `criteria[]`). The interesting question is whether the
  forced-tool-use path handles that shape — it does.
- **Append-only versioning:** never edit a saved profile in place; saving creates
  v(N+1) and flips which one is "active". Same idea as prompt versions and DB
  migrations — history stays truthful.
- **Revealed preference:** what your *behaviour* says you want (the roles you've
  actually applied to), as opposed to what you *say* you want (your notes). The
  propose call feeds the model both.
- **Correlated subquery / anti-join for "latest":** a `NOT EXISTS (... a newer
  row ...)` that keeps only the most recent row per group. Used so re-scoring
  doesn't show stale duplicate cards.

---

## Part 1 — The schema: the rubric, typed once (`shared`)

`IdealJobProfileSchema` is the profile's shape, and — the reusable-schema payoff —
it's simultaneously **three contracts**: the AI's output when proposing, the
request body when saving, and (extended with version metadata) the GET response.

```ts
export const IdealJobProfileSchema = z.object({
  northStar: z.string().describe("One paragraph: the role this candidate is aiming for."),
  hardFilters: z.object({
    compFloor: z.number().int().nullable(),
    locationRule: z.string(),
    remoteRequired: z.boolean(),
  }),
  criteria: z.array(z.object({
    name: z.string(),
    weight: z.number().int().min(1).max(5),
    description: z.string(),
  })).min(1),
});
```

It maps onto the `profile_versions` table by splitting: `northStar` → its own
column, `{ hardFilters, criteria }` → the `rubric` jsonb column. One schema, one
edit surface, stored in the shape the DB already had (from step 1.1).

---

## Part 2 — Propose: forced tool use survives a *nested* schema (`service.ts`)

Step 2.2 proved forced tool use for a flat schema (`FitScore`). The open question
here was whether it holds for a **nested** one — an object with a sub-object and an
array of sub-objects. `proposeProfile` answers it:

```ts
const result = await provider.complete({
  prompt,                              // notes + resume + application history
  schema: IdealJobProfileSchema,       // nested!
  schemaName: "ideal_job_profile",
  tier: "large",                       // quality-critical, rare → the strong model
});
```

Verified live: the model returned a complete, valid profile — `compFloor: 140000`
(pulled from "$140k" in the notes), `locationRule: "Remote (US) only"`, and six
weighted criteria (weights 5,5,4,4,3,3). The `z.toJSONSchema` conversion emits
nested `properties`/`items`, forced tool use fills them, and `safeParse` validates
the whole tree. **No new machinery was needed — the step-2.1 interface just worked
for a richer shape.** That's the dividend of a generic `complete(prompt, schema)`.

Two design choices worth noting:

- **`tier: "large"`.** Proposing a profile is a rare, high-stakes call, unlike bulk
  scoring — so it routes to the strong model (Sonnet) via the tier map, no model
  name in the code.
- **Three inputs, weighted by trust.** The prompt feeds *notes* (stated intent,
  weighted most), *resume* (capability), and *application history* (revealed
  preference). In Phase 2 the resume is still a placeholder, so the propose leans
  on notes + the 38 imported applications — which is why it produced something
  sensible even before Phase 3.2 adds a real resume.

---

## Part 3 — Save: one active version, always (`service.ts`)

Saving is append-only and transactional:

```ts
db.transaction(async (tx) => {
  const max = (await tx.select({ max: sql`coalesce(max(version),0)` })...)[0]?.max ?? 0;
  await tx.update(profileVersions).set({ active: false }).where(eq(active, true));
  const [row] = await tx.insert(profileVersions).values({ version: max + 1, ..., active: true }).returning();
  return toProfileVersion(row);
});
```

The **transaction** is load-bearing: deactivate-all + insert-active must be atomic,
or a crash between them could leave zero active profiles (nothing to score against)
or two (ambiguous). Wrapping both in `db.transaction` means the DB guarantees
all-or-nothing. Editing never mutates an old version, so a `fit_scores` row that
recorded `profileVersionId = <v1>` stays interpretable forever, even after you save
v2 — the same "history must not lie" principle as prompt versions.

---

## Part 4 — Re-score, and the duplicate-card problem it creates

"Re-score open candidates" re-queues already-scored postings:

```ts
// reset each scored open posting's queue row back to pending
.onConflictDoUpdate({ target: scoringQueue.jobPostingId,
                      set: { status: "pending", attempts: 0, lastError: null } })
```

A subsequent `score:drain` then scores them against the now-active profile,
**inserting new `fit_scores` rows** (history kept — old and new scores coexist).
But that creates a problem: triage joined *every* score, so a re-scored posting
would show two cards, one stale.

The fix is a "keep only the latest per posting" filter — a correlated `NOT EXISTS`:

```sql
not exists (
  select 1 from fit_scores fs2
  where fs2.job_posting_id = fit_scores.job_posting_id
    and fs2.created_at > fit_scores.created_at
)
```

Read it as "keep this score only if no *newer* score exists for the same posting."
Verified end to end: re-scoring the three seeded postings against the real profile
changed their scores (the applied-AI IC role **6.0 → 8.0** and pinged the phone; two
PM roles dropped to **2.0 / 1.5** — correctly, they don't fit an IC-engineering
profile), and triage showed exactly three deduped cards, the stale fallback-scored
rows hidden. **The profile demonstrably made scoring sharper** — which is the whole
point of the loop.

---

## Part 5 — The page: propose → edit → save (`ProfilePage.tsx`)

The frontend is a controlled form seeded three ways: from the active profile on
load, from `EMPTY` if none exists, or from the AI draft when you propose. The one
new React wrinkle vs earlier pages is **seeding editable state from a query without
clobbering the user's edits**:

```ts
const [draft, setDraft] = useState<IdealJobProfile | null>(null);
useEffect(() => {
  if (draft === null && profileQ.isSuccess) {           // only seed ONCE
    setDraft(profileQ.data ? toDraft(profileQ.data) : EMPTY);
  }
}, [profileQ.isSuccess, profileQ.data, draft]);
```

The `draft === null` guard means the effect seeds the form exactly once; after that
your keystrokes own `draft` and a background refetch can't overwrite what you're
typing. Proposing deliberately *does* overwrite (`setDraft(aiDraft)`) — that's the
point of the button.

Everything else is the controlled-input + immutable-update pattern from step 1.7,
scaled to a nested object: small `patch` / `patchFilters` / `patchCriterion`
helpers spread-copy the draft so React sees a new object and re-renders. The
criteria list adds/removes rows by mapping and filtering the array.

---

## Part 6 — How you verify it (the checkpoint)

Needs `ANTHROPIC_API_KEY` (propose uses the large tier) and the DB up. With both dev
servers running (`pnpm dev`):

1. Open <http://localhost:5173/profile>. In the notes box, describe what you want
   ("remote-only applied-AI IC role, comp floor ~$140k, no CS degree…") and click
   **✨ Propose with AI** — the form fills with a north star, hard filters, and
   weighted criteria.
2. Edit anything, then **Save profile** → "Saved as v1 (now active)".
   Confirm: `select version, active from profile_versions;`
3. Click **Re-score open candidates**, then run `pnpm --filter api score:drain`.
4. Open **Triage** — the same postings are re-scored against your profile (scores
   shift, and a genuinely-good match may cross 8 and ping your phone), with no
   duplicate cards.

That's the checkpoint: *you built the rubric your scorer grades against, and
watched the scores sharpen when you applied it.*

---

## What's next — Step 3.2 (resume versions)

The propose call still falls back on a placeholder for `{{resume}}`. Step 3.2 fixes
that: upload a resume (`@fastify/multipart` + `mammoth` for docx→text, and your
`Michael_Brown_Resume.pdf` via `pdf-parse`), store the extracted text to
`resume_versions`, set one active — and both the scorer and the profile-proposer
start using real resume text. It also adds the resume **review** and
**tailor-to-posting** features (draft-only, per the house rule).
