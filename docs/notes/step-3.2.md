# Step 3.2 — Resume versions + AI review (and a real bug fix)

> The second Phase-3 placeholder falls: `{{resume}}` becomes real. Upload a PDF or
> DOCX, extract its text, version it, set one active — and the scorer and
> profile-drafter immediately read a real resume instead of a stub. This step also
> adds an AI **review** feature, and — the most instructive part — surfaced a
> genuine reliability bug in the structured-output layer that we fixed for the
> *whole* codebase. Written for a junior dev coming from Python: file uploads,
> text extraction at the edge, and (importantly) how "guided" vs "strict" tool use
> differ.

> **Scope note:** step 3.2 in the plan also includes *tailor-to-posting* (draft a
> tailored resume + outreach note for a specific job). That's the next increment;
> this note covers upload/versions/active + review.

**Deliverable:** a `/resume` page — upload (PDF/DOCX/TXT), a version list with
char counts and an active badge, "Set active", and open-a-version to read its
extracted text or run an AI review against your active profile.

```
upload file ─▶ POST /api/resumes (multipart)
                 │ extractText: pdf-parse / mammoth / utf8
                 ▼
           resume_versions row (extracted text, active)  ──▶ scorer + profile-drafter read the ACTIVE one
                 │
   open a version ─▶ POST /api/resumes/:id/review ─▶ provider.complete(ResumeReviewSchema, large, strict)
```

Files added / changed this step:

```
packages/ai/prompts/review-resume.v1.md + prompts.ts
packages/ai/src/providers/api.ts     # ★ strict tool use + strip unsupported keywords (the fix)
packages/shared/src/index.ts         # ResumeVersion/ResumeDetail/ResumeReview schemas
apps/api/src/modules/resume/
├── service.ts                       # extractText, createResumeVersion, list, detail, setActive, reviewResume
└── routes.ts                        # multipart upload + list/detail/activate/review
apps/web/src/pages/ResumePage.tsx    # the page (+ route + nav)
```

---

## Part 0 — Vocabulary you need first

- **Multipart upload:** how browsers send files — `multipart/form-data`, not JSON.
  A `FormData` on the client; `@fastify/multipart` reads the file stream on the
  server.
- **Text extraction:** pulling plain text out of a binary document (PDF/DOCX). The
  LLM wants words, not layout, so we flatten at the upload edge.
- **Guided vs strict tool use:** with plain (guided) forced tool use, the model is
  *steered* by the tool's schema but can still deviate (return a string where an
  array belongs). **Strict** tool use *guarantees* the output matches the schema.
  This distinction is the heart of this step's bug.
- **Active version:** one row flagged the canonical one everything reads — same
  "always exactly one active, flipped in a transaction" pattern as the profile.

---

## Part 1 — Upload and extract at the edge (`service.ts`, `routes.ts`)

Uploads are `multipart/form-data`, so the route reads the file off the stream
rather than parsing a JSON body:

```ts
await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });
// ...
const file = await req.file();
const buffer = await file.toBuffer();
const created = await createResumeVersion(file.filename, buffer);
```

The interesting work is `extractText` — one function that turns any supported file
into plain text, dispatching on extension:

```ts
if (ext === ".pdf")  { const { PDFParse } = await import("pdf-parse");
                       text = (await new PDFParse({ data: buffer }).getText()).text; }
else if (ext === ".docx") { text = (await mammoth.extractRawText({ buffer })).value; }
else if (ext === ".txt" || ext === ".md") { text = buffer.toString("utf8"); }
else throw new Error(`Unsupported resume type "${ext}"`);
```

Three things worth understanding:

- **Extract once, at the boundary.** The DB stores *text*, not the PDF. Everything
  downstream (scorer, profile-drafter, review) reads that text and never has to
  know it came from a PDF. This is the same "cross the boundary once" instinct as
  Zod-parsing external input — normalize at the edge, keep the core simple.
- **Fail loudly on empty extraction.** A scanned-image PDF yields no text; rather
  than silently store a blank resume that quietly poisons every score, we throw so
  the upload returns a clear 400. (Verified: the real PDF extracted 4,458 chars.)
- **`await import(...)` (dynamic import).** `pdf-parse`/`mammoth` are heavier CJS
  libraries; importing them lazily inside the function means they're only loaded
  when someone actually uploads — the server boots without paying for them.

Storage: the original file is written to `apps/api/data/resumes/<uuid>.<ext>`
(gitignored — never commit someone's resume) *and* the extracted text goes in the
DB. Uploading makes the new version active in a transaction, so it's immediately
the resume everything reads.

---

## Part 2 — The bug: guided tool use isn't a guarantee (`providers/api.ts`)

This is the part to really absorb. The review feature failed on first run — the
model returned:

```
✖ Invalid input: expected array, received string  → at strengths
✖ Invalid input: expected array, received undefined → at weaknesses, sectionSuggestions, atsFlags
```

Debugging ruled out the obvious suspects:
- **Not the schema** — `z.toJSONSchema(ResumeReviewSchema)` was perfect: `strengths`
  as `{type: array, items: {type: string}}`, all fields required,
  `additionalProperties: false`.
- **Not truncation** — a debug log showed `stop_reason: "tool_use"` (a clean
  finish, not `max_tokens`), and bumping `maxTokens` changed nothing.

The actual cause: the model wrote a giant essay into `summary` and stringified
`strengths`, **ignoring the array structure entirely**. Why could it? Because plain
forced tool use only *guides* the model with the schema — it doesn't *enforce* it.
`FitScore` and the profile happened to comply; the free-form review didn't.

**The fix — strict tool use — applied to every call:**

```ts
const tool = {
  name: req.schemaName,
  input_schema: toInputSchema(req.schema),
  strict: true,          // ← GUARANTEES the arguments validate against the schema
};
```

`strict: true` makes the API constrain generation to the schema, so the model
*cannot* return a string where an array belongs or drop a required field. One
catch: strict requires the schema use only supported JSON-Schema keywords —
numeric/length bounds like `minimum`/`maxLength`/`minItems` aren't allowed. Our
`FitScore.score.min(0).max(10)` and profile `weight.min(1).max(5)` emit exactly
those. So `toInputSchema` now strips them before sending:

```ts
const STRICT_UNSUPPORTED = new Set(["minimum","maximum","minItems", /* … */]);
function stripUnsupported(node) { /* recursively delete those keys */ }
```

We lose nothing by stripping them: they were only advisory to the model, and our
own `safeParse` (which runs the *full* Zod schema, `min`/`max` included) still
enforces every constraint after the call. So the guarantee is now two-layered:
the API enforces the *structure*, Zod enforces the *values*.

> **Interview-ready framing:** *"Forced tool use guides the model with a schema but
> doesn't enforce it — a free-form task made the model return a string where an
> array belonged. I switched to strict tool use, which guarantees schema-valid
> structure, and stripped the numeric-bound keywords strict doesn't support since
> my Zod parse re-checks those anyway."*

Verified after the fix: review returned a clean structure (4 strengths, 7
weaknesses, 8 section suggestions, 5 ATS flags), *and* `FitScore` scoring still
worked (8.5, valid) with its `min`/`max` stripped — so the fix hardened the whole
structured-output layer, not just review.

---

## Part 3 — The review feature (`service.ts`)

`reviewResume` is a straightforward large-tier call, notable mainly for being
**profile-aware**: it reviews the resume *against the active profile*, so the
feedback is for the role you're chasing, not in the abstract.

```ts
const prompt = renderPrompt(REVIEW_RESUME_PROMPT, {
  resume: detail.extractedText,
  profile: await activeProfileText(),   // reuses the profile module's active profile
});
const result = await provider.complete({ schema: ResumeReviewSchema, tier: "large", maxTokens: 4096 });
```

`maxTokens: 4096` (not 2048) because a full review — summary plus four bullet
arrays — is verbose; the smaller cap was a red herring during debugging but the
larger value is genuinely right for the output size. The review output is
draft-only feedback (strengths / weaknesses / per-section suggestions / ATS
flags), per the house rule *AI drafts, human finishes*.

Live result against the real resume, reviewed against the IC-engineering profile:
*"reads as a founder/operator pivoting into applied AI rather than a proven IC
engineer"* — an accurate, useful read, exactly because it judged against the
profile.

---

## Part 4 — The page (`ResumePage.tsx`)

Mostly the query + mutation patterns you've seen, with two small new wrinkles:

- **A raw `fetch` for the upload.** `apiSend` sends JSON; a file needs
  `FormData`, so the upload mutation hand-rolls the `fetch` — but still
  `ResumeVersionSchema.parse(json)`s the response, so it stays inside the Zod
  boundary like every other call.
- **`enabled` on a dependent query.** The detail query only runs when a version is
  selected: `useQuery({ queryKey: ["resume", selectedId], enabled: selectedId !==
  null })`. TanStack Query's `enabled` flag is how you make a query wait for a
  precondition instead of firing on mount.

Everything else — the version list, the active badge, "Set active", the
view/review dialog — is the controlled-component + invalidation vocabulary from
earlier steps.

---

## Part 5 — How you verify it (the checkpoint)

Needs `ANTHROPIC_API_KEY` (review is a large-tier call) and the DB up.

1. Open <http://localhost:5173/resume> and upload a resume (there's a real
   `Michael_Brown_Resume.pdf` in the repo root). It appears as an active version
   with a char count.
2. Confirm the DB: `select label, active, length(extracted_text) from resume_versions;`
3. Click **View / Review** → read the extracted text, then **✨ Review with AI** →
   a structured review (summary, strengths, weaknesses, section suggestions, ATS
   flags) appears.
4. The payoff: with a resume now active, re-score a posting (`score:enqueue` +
   `score:drain`) — the scorer now reads real resume text instead of the
   placeholder, so scores get another notch sharper.

That's the checkpoint: *your real resume is in the system, versioned, feeding the
scorer, and the AI will critique it against the exact role you're targeting.*

---

## What's next — Step 3.2b (tailor-to-posting), then 3.3 (alternate providers)

- **Tailor-to-posting** (the remaining slice of 3.2): from a high-scoring job,
  generate tailored resume suggestions + a drafted outreach note, shown as a diff
  and saved as a *draft* attached to the application — you finish it by hand.
- **Step 3.3** adds the `CliProvider` and `CoworkProvider` so the exact same
  scoring/review/propose calls can run through the `claude` CLI (no API key) or a
  file-queue Cowork session — the third and final proof of the step-2.1 provider
  abstraction.
