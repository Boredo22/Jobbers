# Tailor v2 — full customized resume, ad keywords, multiple bases

Handoff spec for Claude Code. Written against the codebase as of commit `db5d5aa`
(Phase 3 complete + multi-profile stages 1/1.5). Follow the house rules in
`CLAUDE.md`: one step at a time, checkpoint before moving on, teaching-mode
explanation after each step, Biome + typecheck clean before each commit.

---

## 1. The goal (owner's words, translated)

> "When I identify a good role I want to apply for, a button to generate a
> customized resume based off the template on hand, using keywords directly from
> the ad, with support for multiple resumes as a base, and only running for
> applications to limit AI cost (Sonnet)."

Step 3.2b already shipped most of the *plumbing* for this: the TailorDialog on
triage and pipeline cards, the `tailored_drafts` table, the Sonnet (`large`)
tier, and the human-click cost gate. What it produces, though, is **3–6 edit
suggestions + an outreach note** — not a complete ready-to-send resume. This
spec upgrades tailoring from "suggestions" to "document," adds an explicit
keyword-coverage map, and lets you pick which base resume to tailor from.

## 2. What exists today (read these before coding)

| Piece | Where | State |
|---|---|---|
| Tailor endpoint + service | `apps/api/src/modules/tailor/` | Edits + outreach note only; always uses the *globally active* resume |
| Tailor output contract | `TailoredDraftSchema` in `packages/shared/src/index.ts` | `summary`, `edits[]` (before/after), `outreachNote` |
| Prompt | `packages/ai/prompts/tailor-posting.v1.md` | Mentions keyword alignment inside edits; no structured keyword output |
| Draft storage | `tailoredDrafts` in `apps/api/src/db/schema.ts` | jsonb edits; linked to posting + application + resume version |
| UI | `apps/web/src/components/TailorDialog.tsx` | Generate → word-diff edits → edit outreach note → save |
| Resume versions | `resumeVersions` table + `modules/resume/` | Multiple rows supported; exactly one globally `active`; no base/tailored distinction |
| Tracks (multi-profile) | `profiles` table | Each track has an (optional) `resumeVersionId` — **currently unused by tailoring** |
| Cost control | Human click + `ai_runs` ledger | Already correct — keep it |

### Known tie-in problems to fix along the way (found in review, 2026-07-20)

1. **Tailoring is not track-aware.** `tailor/service.ts` → `activeProfileText()`
   does `where(active).limit(1)` on `profile_versions`. Under multi-profile,
   several versions are active (one per track), so which profile flavors the
   tailoring is arbitrary. The base-resume picker (step T2) must also pick the
   profile deliberately.
2. **Save-time provenance can lie.** `saveTailoredDraft()` re-resolves the
   *active* resume at save time. If the active resume changed between generate
   and save — and certainly once bases are selectable — the saved
   `resumeVersionId` is wrong. Generate must return the id it used; save must
   accept it from the client.
3. **`applications.resumeVersionId` is never set.** The column and the
   `ApplicationCreateSchema` field exist, but no caller passes it — so "which
   resume went out" is currently never recorded. Step T3/T4 close this loop.

## 3. Design decisions (the "why" — don't re-litigate, but do flag surprises)

- **Keywords ride in the same AI call.** The tailor prompt already reads the
  full JD; asking it to *also* emit a keyword-coverage map costs a few hundred
  output tokens, not a second call. No new endpoint, no new `ai_runs` feature.
- **The full resume is assembled deterministically, not generated.** Edits
  already quote `original` verbatim — so the complete tailored document is
  `baseText` with each `original → tailored` replacement applied, computed by a
  pure function at **zero incremental AI cost**. This also preserves the
  never-invent guarantee mechanically: the only text that can change is text an
  edit explicitly touched, and the human reviewed every edit as a diff first.
  (If the mechanical assembly proves clunky in practice, a "full rewrite" mode
  on Sonnet is a v3 option — do not build it now.)
- **"Multiple bases" = pick a resume version at generate time**, defaulting
  sensibly: explicit pick → the track's own resume → the globally active one.
  The `profiles.resumeVersionId` column was built for exactly this.
- **Tailored outputs become `resume_versions` rows** (`kind: "tailored"`), so
  the existing `applications.resumeVersionId` link finally gets used and every
  application records the exact document that went out. Tailored versions are
  never auto-`active` — the scorer keeps reading the base.
- **Cost gate stays the button.** No budget machinery. One click = one Sonnet
  call ≈ 4–5k input + ~2.5–3k output ≈ **$0.05–0.06** at sticker price; the
  assembly step is free. All runs land in `ai_runs` as feature `tailor`.

---

## 4. Build steps

### Step T1 — Schema + shared contracts

**Migration** (`drizzle-kit generate` → read the SQL → `migrate`):

- `resume_versions` gains:
  - `kind` text enum `["base", "tailored"]`, not null, default `"base"`;
  - `parent_id` uuid, nullable, self-reference to `resume_versions.id`
    (Drizzle self-references need the `AnyPgColumn` callback form — check the
    Drizzle docs);
  - `job_posting_id` uuid, nullable, references `job_postings.id` (which
    posting a tailored version was made for).
- `tailored_drafts` gains `keywords` jsonb, not null, default `[]` (old rows
  simply have no keywords).

**Shared schemas** (`packages/shared/src/index.ts`):

```ts
export const KeywordHitSchema = z.object({
  keyword: z.string().describe("Verbatim term/phrase from the job ad."),
  covered: z.boolean().describe("Does the resume already truthfully support it?"),
  note: z.string().describe(
    "If covered: where in the resume. If not: how to honestly address it — or 'genuine gap, do not fake'.",
  ),
});
```

- `TailoredDraftSchema` gains `keywords: z.array(KeywordHitSchema)`.
- `ResumeVersionSchema` gains `kind`, and nullable `parentId` / `jobPostingId`.
- New `TailorRequestSchema = z.object({ resumeVersionId: z.string().uuid().optional(), profileId: z.string().uuid().optional() })`.

**✅ Checkpoint:** migration applied; `\d resume_versions` and
`\d tailored_drafts` show the new columns; `pnpm -r typecheck` clean.
Commit: `tailor-v2: schema — resume kinds + keyword map (step T1)`.

### Step T2 — API: base selection, track-awareness, keyword prompt

- **Prompt:** copy `tailor-posting.v1.md` → `tailor-posting.v2.md`. Add a
  `keywords` section to "What to produce": extract the 8–15 most
  screening-relevant terms **verbatim from the ad**, mark each covered/not
  against the resume, and *prefer edits that work uncovered-but-true keywords
  into the resume's own language*. Keep (and strengthen) the standing rule:
  never claim experience the resume doesn't support; a genuine gap is reported
  as a gap, not papered over. Point the service at the v2 constant.
- **Base/profile resolution:** in `tailor/service.ts`, extract a pure function
  (unit-testable) that resolves the base:
  `explicit resumeVersionId → profiles.resumeVersionId (when profileId given) → globally active resume`.
  When `profileId` is given, `activeProfileText()` must read *that track's*
  active `profile_versions` row — this fixes tie-in problem #1.
- **Wire changes** (`tailor/routes.ts`):
  - `POST /api/postings/:id/tailor` — body is `TailorRequestSchema`; response
    becomes `{ draft, resumeVersionId }` so the client knows what was used
    (fixes tie-in problem #2). 404 unknown posting/resume, 409 no resume.
  - `POST /api/postings/:id/tailor/save` — body gains `resumeVersionId`;
    `saveTailoredDraft` stores it instead of re-resolving.
- Bump `maxTokens` to 6144 (keywords add volume; the 3.2 review already hit
  truncation at 2048 once).
- **Tests (Vitest, they pay rent):** the resolution function; v2 prompt renders
  with all placeholders filled.

**✅ Checkpoint:** `curl -X POST .../tailor -d '{"resumeVersionId":"<some non-active id>"}'`
returns a draft with a populated `keywords` array and echoes that id;
`ai_runs` shows the Sonnet call. Commit:
`tailor-v2: keyword map + selectable base, track-aware (step T2)`.

### Step T3 — Deterministic assembly → a tailored resume version

- **Pure function** `applyEdits(baseText, edits)` in the tailor module,
  returning `{ text, applied: TailorEdit[], failed: TailorEdit[] }`:
  - each edit: replace the **first** occurrence of `original` with `tailored`;
  - `original === ""` (new content): collect and append under a clearly marked
    block at the end (`## Additions — place by hand`), since placement is a
    human decision;
  - an `original` not found verbatim (model quoted loosely) goes in `failed` —
    reported, never silently dropped.
- **Vitest** for `applyEdits` — this is the highest-value test in the feature:
  replacement, first-occurrence-only, empty-original additions, not-found
  reporting, multiple edits in one section.
- **Endpoint:** `POST /api/postings/:id/tailor/resume` — body
  `{ draft: TailoredDraftSchema, resumeVersionId, label? }`. Assembles, inserts
  a `resume_versions` row (`kind: "tailored"`, `parentId` = base,
  `jobPostingId`, `active: false`, label defaulting to
  `"<Company> — <Title>"`), and if an application already exists for the
  posting, sets its `resumeVersionId` (tie-in problem #3). Returns
  `{ resume: ResumeDetail, failed: TailorEdit[] }`.
- No AI call in this step — it must work offline.

**✅ Checkpoint:** unit tests green; endpoint returns full assembled text;
the new row appears with `kind = 'tailored'` and correct parent; the linked
application row (if any) points at it. Commit:
`tailor-v2: deterministic assembly → tailored resume version (step T3)`.

### Step T4 — UI

`TailorDialog.tsx`:

- **Base picker** at the top: a select of resume versions (bases only),
  defaulting to the active one; if tracks exist, offer them as presets that set
  both base + profile. Disabled after a draft is generated (re-tailor to switch).
- **Keyword chips** under the summary: green = covered, amber = not covered,
  with the `note` as tooltip/expander. This is the "keywords directly from the
  ad" made visible.
- After the edits section: **"Assemble full resume"** button → calls the T3
  endpoint → shows the complete text in an editable `<textarea>` (monospace),
  any `failed` edits flagged above it ("couldn't auto-apply, do these by
  hand"), plus **Copy** and **Download .md** buttons. Saving here is what
  creates the version + application link; make the success state say so.

`ResumePage.tsx`: show a `kind` badge; tailored rows display their parent base
and posting; guard "set active" so a tailored version can't silently become
the scorer's resume (confirm or disallow).

Mark-applied flow (Triage/Pipeline): when an application is created for a
posting that has a tailored version, pass its id as `resumeVersionId` in the
existing `POST /api/applications` body — the schema already accepts it.

**✅ Checkpoint (end-to-end):** Triage → pick a role → Tailor → choose base →
review keywords + diffs → assemble → download the .md → mark applied → the
Pipeline card's application row shows the tailored resume version. One Sonnet
call total, visible in `ai_runs`. Commit: `tailor-v2: dialog — base picker,
keyword chips, full-resume assembly (step T4)`.

---

## 5. Guardrails (restating the house rules that bind here)

- **AI drafts, human finishes.** The assembled resume is a draft file the owner
  downloads and formats; nothing is auto-sent. Keep the existing dialog copy.
- **Never invent experience.** The keyword map must mark honest gaps as gaps.
  The deterministic assembly enforces this structurally — keep it that way.
- **Every LLM output crosses the Zod boundary** (already true via
  `provider.complete({ schema })` — extend the schema, don't bypass it).
- **Sonnet only, human-gated.** Tier `large`, no background/batch tailoring, no
  tailor calls from the scorer or poller. The button is the budget.
- Teaching mode: after each step, explain the new concepts (self-referencing
  FK in Drizzle, pure-function extraction for testability, optimistic vs.
  invalidate in the dialog mutations) before proceeding to the next.
