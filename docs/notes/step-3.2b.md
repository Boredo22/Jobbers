# Step 3.2b — Tailor-to-posting (the last slice of 3.2)

> The final Phase-3 resume feature: from a single high-scoring job, the AI drafts
> concrete resume **edits** (before → after) plus a draft **outreach note**, tuned
> to that posting. The edits render as a side-by-side word diff; the outreach note
> is an editable draft the human finishes and sends by hand. Saved, it becomes a
> `tailored_drafts` row attached to the posting — and to the application, when one
> exists. Written for a dev coming from Python: the interesting ideas are the
> generate-vs-save split, computing a diff in the browser, and "attach to the
> application if there is one" as a data-model decision.

**Deliverable:** on each `/triage` card, an **✨ Tailor** button opens a dialog:
generate → review the diff + outreach note → edit the note → **Save draft**.

```
triage card ─▶ POST /api/postings/:id/tailor  (large tier, not saved)
                 │  loadPosting + active resume + active profile → render prompt
                 ▼
        TailoredDraft { summary, edits[{section,original,tailored,rationale}], outreachNote }
                 │  shown as a word diff; outreach note is edited in a <textarea>
                 ▼
        POST /api/postings/:id/tailor/save  ─▶ tailored_drafts row (linked to the application if one exists)
```

Files added / changed:

```
packages/ai/prompts/tailor-posting.v1.md + prompts.ts + index.ts   # TAILOR_POSTING_PROMPT
packages/shared/src/index.ts       # TailorEdit / TailoredDraft / TailoredDraftRecord
apps/api/src/db/schema.ts          # tailored_drafts table; "tailor" added to ai_runs.feature
apps/api/drizzle/0005_*.sql        # the generated migration (one new table)
apps/api/src/lib/ai.ts             # AiFeature gains "tailor"
apps/api/src/modules/tailor/{service.ts,routes.ts}   # generate / save / get-latest
apps/api/src/server.ts             # register tailorRoutes
apps/web/src/components/TailorDialog.tsx             # the dialog + WordDiff
apps/web/src/pages/TriagePage.tsx                    # ✨ Tailor button + mount
apps/web/package.json              # + diff (word-level diff library)
```

---

## Part 0 — Vocabulary you need first

- **Generate vs save:** two endpoints on purpose. *Generate* is the expensive AI
  call and returns an un-saved draft; *save* persists whatever the human ended up
  with. Splitting them means re-generating costs nothing to throw away, and only
  the human-approved version hits the DB.
- **Word diff:** given two strings (original, tailored), the smallest set of
  word-level insertions/deletions that turns one into the other. The `diff`
  library computes it; we render it.
- **"Attached to the application":** a saved draft points at the `job_posting`
  (always known) and, *if* an application already exists for that posting, at the
  `application` too — so it's reachable from the pipeline later.

---

## Part 1 — The output contract (`packages/shared`)

Tailoring's whole value is that it's **structured and diffable**, so the schema is
the design. An edit is a before/after pair, not free prose:

```ts
export const TailorEditSchema = z.object({
  section: z.string().describe("e.g. 'Summary', 'Experience — Acme'."),
  original: z.string().describe("existing text, quoted verbatim so the UI can diff it. '' = new content"),
  tailored: z.string().describe("the proposed replacement"),
  rationale: z.string().describe("one sentence: why this helps for THIS role"),
});
export const TailoredDraftSchema = z.object({
  summary: z.string(),
  edits: z.array(TailorEditSchema),
  outreachNote: z.string(),
});
```

The key move: `original` is **quoted verbatim from the resume**. That's what makes
a real diff possible — the UI diffs `original` against `tailored`. If the model
paraphrased instead of quoting, the diff would be noise. The `.describe()` string
instructs the model to quote, and (because those descriptions become the JSON
Schema the model sees — step 2.2) that instruction rides along for free.

`TailoredDraftRecordSchema` extends the draft with the saved-row metadata
(`id`, `jobPostingId`, `applicationId`, `resumeVersionId`, provenance, `createdAt`)
— the same "AI output schema, then extend it for the stored shape" pattern the
profile used in 3.1.

---

## Part 2 — Generate, then save (`service.ts`, `routes.ts`)

`tailorPosting()` is a sibling of `scorePosting()` / `reviewResume()` — gather the
three inputs (posting JD, active resume, active profile), render the versioned
prompt, ask the provider for the schema, log the cost. Two differences worth
noticing:

- **It requires a real resume.** The scorer falls back to a placeholder when no
  resume is active; tailoring can't — you can't rewrite a stub. So a missing
  active resume throws a typed `NoActiveResumeError`, which the route maps to a
  **409** with an actionable message ("upload a resume first"). Typed errors →
  precise HTTP codes is the pattern: the route switches on `err instanceof …`.
- **Large tier, `maxTokens: 4096`.** Edits (each carrying two blocks of text) plus
  an outreach note is verbose — the same lesson as the resume review, where 2048
  truncated the tool-call JSON mid-array.

`saveTailoredDraft()` holds the one genuinely interesting data decision:

```ts
const [app] = await db.select({ id: applications.id })
  .from(applications)
  .where(eq(applications.jobPostingId, jobPostingId))   // is there an application yet?
  .orderBy(desc(applications.appliedAt)).limit(1);
// ...insert tailored_drafts with applicationId: app?.id ?? null
```

The plan says the draft is "attached to the application," but from triage you often
tailor *before* you've marked the job applied — so there may be no application yet.
Rather than force an ordering, the draft always attaches to the **posting**, and
*additionally* to the application when one exists. The `applicationId` column is
nullable exactly to express "attached if there's something to attach to."

> **Note on `modelUsed`.** The saved row stores `modelUsed: "human-edited"`, not the
> generation model — because the saved copy is the human-finished artifact, which
> is what the house rule cares about. The *true* generation model + token cost is
> already in the `ai_runs` ledger from the generate call, so no provenance is lost.

The routes are the module's third instance of the same trio the resume module used
(generate / save / get-latest), so nothing new there except the 409 branch.

---

## Part 3 — Diffing in the browser (`TailorDialog.tsx`)

The diff is computed **client-side** — the server sends `original` and `tailored`
strings; the browser turns them into a highlighted two-column view with the `diff`
library's `diffWords`:

```ts
const parts = diffWords(original, tailored);   // [{value, added?, removed?}, ...]
// left column  = parts where !added  (removed spans in red strikethrough)
// right column = parts where !removed (added spans in green)
```

Three things to internalize:

- **`diffWords` returns a change list, not HTML.** Each chunk is `{value, added?,
  removed?}`. "Original" is every chunk that isn't an *addition*; "tailored" is
  every chunk that isn't a *deletion*; unchanged chunks appear in both. Rendering
  is just two filters over the same array.
- **React keys without the array index.** Biome's recommended preset forbids
  `key={i}` (an index key breaks React's reconciliation when the list reorders).
  Word chunks have no natural id, so we synthesize a stable one from a **running
  character offset**: ``key={`${offset}:${value}`}``. Unique, and not the index.
- **Reset-on-open via `key`, not `useEffect`.** Each dialog needs fresh state when
  a *different* posting opens. Instead of an effect that watches the prop and calls
  setters (which Biome flags as an unnecessary dependency, and which is a code
  smell), the parent gives the component a `key={jobPostingId}`. When the key
  changes React **remounts** the component, so `useState` re-initialises for free.
  This is the idiomatic React answer to "reset state when a prop changes."

The outreach note is the one **editable** field — a controlled `<textarea>` bound
to `draft.outreachNote`. That's the house rule made physical: the thing that will
leave the machine is a draft the human edits, and Save persists exactly what they
see. The resume edits are shown read-only (suggestions to apply by hand).

---

## Part 4 — How you verify it (the checkpoint)

Needs the DB up, `ANTHROPIC_API_KEY` set (tailoring is a large-tier call), and an
**active resume** (upload one on `/resume` first — that's what 3.2 core added).

1. Apply the migration: `pnpm --filter api db:migrate` (creates `tailored_drafts`).
2. Make sure you have scored candidates on `/triage` (else `score:enqueue` +
   `score:drain`). On any card click **✨ Tailor** → **Tailor with AI**.
3. You should see: a one-paragraph *angle*, 3–6 resume edits each rendered as a
   red/green before→after diff with a rationale, and a draft outreach note in an
   editable box.
4. Edit the outreach note, click **Save draft**. Confirm the row:
   `select job_posting_id, application_id, left(outreach_note, 60) from tailored_drafts;`
5. Confirm the cost was logged: `select feature, model, est_cost from ai_runs where feature='tailor';`

That's the checkpoint: *a high-scoring posting becomes a concrete, diffed set of
resume edits and a ready-to-finish outreach note, saved as a draft — the "apply
smarter" half of the app is now real.*

---

## What's next — Step 3.3 (alternate providers)

The `CliProvider` and `CoworkProvider` let the exact same tailor/score/review calls
run through the `claude` CLI or a file-queue Cowork session — **no API key** — the
final proof of the step-2.1 provider abstraction. See `step-3.3.md`.
