# Step 2.3 — Prompts as versioned files

> A short, high-leverage step: move the scoring prompt out of a string literal
> and into a versioned markdown file, with a tiny renderer. It also lands the
> project's **first unit test**. Written for a junior dev coming from Python —
> every new idea (why version a prompt, why a regex is enough, what Vitest is)
> gets explained. By the end you should understand why prompts get the same
> version-control treatment as code, and how a pure function earns a test.

**Deliverable:** the scorer's prompt lives in
[`packages/ai/prompts/score-job.v1.md`](../../packages/ai/prompts/score-job.v1.md)
with `{{profile}}`, `{{resume}}`, `{{jd}}` placeholders; a `renderPrompt` helper
fills them in; and `pnpm --filter @jobber/ai test` passes four tests covering it.

```
score-job.v1.md   {{profile}} {{resume}} {{jd}}
       │
renderPrompt(file, vars) ──regex replace──▶ full prompt string ──▶ provider.complete(...)
       │
promptVersion(file) ─▶ "v1"   (stored per score in step 2.4, so old scores stay interpretable)
```

Files added / changed this step:

```
packages/ai/
├── prompts/score-job.v1.md     # the scoring prompt, with placeholders + score anchors
├── src/prompts.ts              # renderPrompt() + promptVersion() + SCORE_JOB_PROMPT
├── src/prompts.test.ts         # the first Vitest test
├── src/index.ts                # export the renderer
└── package.json                # + vitest, "test" script
package.json                    # + root "test" → pnpm -r test
apps/api/src/scripts/score-one.ts  # now renders the file prompt instead of an inline string
```

---

## Part 0 — Vocabulary you need first

- **Prompt versioning:** treating each iteration of a prompt as an immutable,
  named artifact (`v1`, `v2`, …) rather than editing one string in place.
- **Placeholder / template variable:** a `{{name}}` marker in the prompt text that
  gets replaced with real content at render time. Like a Python f-string hole, but
  the template lives in a file and the filling happens in a helper.
- **Pure function:** a function whose output depends only on its inputs, with no
  side effects. `renderPrompt(file, vars)` is (nearly) pure — same inputs, same
  string out — which is exactly what makes it cheap to test.
- **Unit test:** code that calls a function with known inputs and asserts on the
  output. **Vitest** is the runner (think `pytest`): `describe`/`it`/`expect` map
  onto `class`/`def test_`/`assert`.
- **Fixture:** stand-in test data (here, a fake profile/resume/JD) used to exercise
  code without needing the real thing.

---

## Part 1 — Why a prompt is a *file*, and why it's *versioned*

The prompt is the single most-tuned, least-stable part of an AI feature — you'll
rewrite it dozens of times chasing better calibration. Two problems follow if it's
a string literal buried in code:

1. **Diffs are unreadable.** A reworded paragraph inside a giant template literal
   is a miserable git diff. As its own `.md` file, a prompt edit reads like prose.
2. **History becomes uninterpretable.** Say you score 500 jobs, then rewrite the
   prompt. Were those 500 scored by the old wording or the new one? If you edited
   in place, you can't know — the old scores now *lie* about how they were made.

The fix is the same instinct as database migrations or `profile_versions`:
**versioned, immutable artifacts.** `score-job.v1.md` is frozen; when you rewrite,
you add `score-job.v2.md` and bump one constant. The version tag (`v1`) gets stored
on each `fit_scores` row (wired in step 2.4), so every score records the exact
prompt that produced it. Old scores stay interpretable forever.

> **Interview-ready framing:** *"Prompts are versioned files, not string literals,
> so prompt edits are readable diffs and every stored score records which prompt
> version graded it — historical scores never silently change meaning."*

---

## Part 2 — The renderer: a regex is genuinely enough (`prompts.ts`)

No template library — the whole substituter is one regex replace:

```ts
export function renderPrompt(promptFile: string, vars: Record<string, string>): string {
  const raw = readFileSync(new URL(promptFile, PROMPTS_DIR), "utf8");
  return raw.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!(key in vars)) {
      throw new Error(`renderPrompt: prompt "${promptFile}" needs {{${key}}}, but it wasn't provided.`);
    }
    return vars[key] ?? "";
  });
}
```

Three things worth understanding here:

- **`String.replace` with a function callback.** When the second argument to
  `.replace` is a function, it's called for every match; whatever it returns is
  substituted. The `/g` flag makes it run for *all* `{{...}}`, not just the first.
  `(\w+)` captures the name inside the braces and passes it as `key`.
- **Missing variable → throw, not silence.** The tempting default is to leave an
  unknown `{{jd}}` untouched. That's the dangerous choice: you'd ship literal
  "{{jd}}" text to the model, pay for the call, and get a garbage score with no
  error. A hard throw turns a silent, billed mistake into a loud, free one. This is
  the same "fail loudly at the boundary" instinct as the Zod env gateway.
- **Resolve the file from the module, not the cwd.** `new URL("../prompts/",
  import.meta.url)` locates the prompts dir *relative to this source file*, so it
  works no matter what directory you launched the process from — under `tsx`,
  Vitest, or Vite. (`import.meta.url` is the ES-module "where am I?" — there's no
  `__dirname` in ESM.)

And the version parser — deliberately strict:

```ts
export function promptVersion(promptFile: string): string {
  const match = promptFile.match(/\.(v\d+)\.md$/);
  if (!match) throw new Error(`"${promptFile}" has no vN version tag`);
  return match[1] as string;
}
```

It *throws* on an unversioned filename rather than defaulting to `"v1"` — so a
prompt physically can't enter the system without a version. Make the safe path the
only path.

---

## Part 3 — What's in the prompt (and what deliberately isn't)

`score-job.v1.md` does four jobs:

1. **Frames the task narrowly** — "ONE posting for ONE candidate," and calls the
   `fit_score` tool rather than replying in prose (reinforcing the forced-tool-use
   contract from step 2.2).
2. **Injects the three inputs** via `{{profile}}` (constraints + goals),
   `{{resume}}` (evidence of ability), `{{jd}}` (the posting).
3. **Anchors the score** — explicit "2 / 5 / 8 / 10 means…" definitions. This is
   the single most important calibration lever: without anchors, LLM scores drift
   upward and cluster at 7. The anchors in the prompt *and* the field descriptions
   on `FitScoreSchema` (which reach the model through the tool schema) work
   together.
4. **Pins down `credentialGapFlag`** — flag only a *hard* requirement the candidate
   fails (degree required, N years in a niche, a gating screen), explicitly *not* a
   "nice to have."

Two deliberate scoping calls, worth defending:

- **No structured comp extraction.** The plan floated having the scorer pull comp
  out of the posting. We don't — the **poller already parses `compMin`/`compMax`**
  into `job_postings` at ingestion (step 1.3). Re-extracting it in the LLM would be
  redundant and less reliable than the ATS's own fields. The prompt just asks the
  model to *mention* comp in the rationale when it's relevant to fit.
- **No "suggested outreach channel" field.** That's a Phase 3 outreach concern; the
  v1 output schema stays tight (score, matchPoints, gaps, credentialGapFlag,
  rationale). Keeping the schema minimal keeps scoring cheap and focused.

---

## Part 4 — The first unit test (`prompts.test.ts`)

CLAUDE.md §3: *tests where they pay rent — normalizers, prefilter, prompt
rendering.* Prompt rendering is the textbook case: a pure function with sharp edges
(missing vars, version parsing). So this step introduces **Vitest**, the runner.

```ts
import { describe, expect, it } from "vitest";

describe("renderPrompt", () => {
  it("substitutes every placeholder in the real v1 scoring prompt", () => {
    const out = renderPrompt(SCORE_JOB_PROMPT, { profile: "P", resume: "R", jd: "J" });
    expect(out).toContain("P");
    expect(out).not.toMatch(/\{\{\w+\}\}/);   // nothing left un-substituted
  });

  it("throws when a required placeholder is missing", () => {
    expect(() => renderPrompt(SCORE_JOB_PROMPT, { profile: "p", resume: "r" }))
      .toThrow(/\{\{jd\}\}/);
  });
});
```

Notes for someone coming from `pytest`:

- **`describe`/`it`** group and name tests; **`expect(x).toBe(...)` / `.toThrow(...)`**
  are the assertions. Direct analogues of a `class TestFoo` with `def test_bar` and
  `assert`.
- **We test against the *real* `score-job.v1.md`, not a mock.** So the test does
  double duty: it verifies the renderer *and* guards the shipped prompt's shape —
  if someone deletes the `{{jd}}` placeholder, the "throws when missing" test flips
  and tells you.
- **The negative test matters most.** "It fills placeholders" is obvious; "it
  *throws* on a missing one" is the behavior that protects you from silently
  shipping broken prompts. Testing the failure path is where the value is.

Run it with `pnpm --filter @jobber/ai test`, or `pnpm test` from the root (the new
root script fans out to every package via `pnpm -r test`).

---

## Part 5 — The checkpoint script now uses the file

`score-one.ts` no longer hand-builds a prompt string. It splits the old combined
blob into a `PROFILE` and a `RESUME` fixture and renders the real file:

```ts
const prompt = renderPrompt(SCORE_JOB_PROMPT, { profile: PROFILE, resume: RESUME, jd: JD });
```

So re-running `pnpm --filter api score:one` now exercises the exact prompt path the
real scorer will use in step 2.4 — the only thing that changes there is *where*
`profile`/`resume`/`jd` come from (the active profile version, the active resume,
and a real posting, instead of fixtures).

---

## Part 6 — How you verify it

Step 2.3 has no live checkpoint in the plan (it's plumbing). Verify it two ways:

```bash
pnpm --filter @jobber/ai test      # → 4 passed
pnpm -r typecheck                  # → clean
```

Optionally re-run the paid scorer to see the file-based prompt in action (costs a
fraction of a cent, needs your key):

```bash
pnpm --filter api score:one        # same FitScore flow, now from score-job.v1.md
```

---

## What's next — Step 2.4 (scoring pipeline + feedback)

The payoff. Step 2.4 builds `modules/scoring`: `scorePosting(id)` assembles a real
JD + the active resume text + the active profile version, calls
`provider.complete({ schema: FitScoreSchema })`, and inserts a `fit_scores` row —
storing the model *and* the prompt version (`promptVersion(SCORE_JOB_PROMPT)`) from
this step, so scores stay interpretable. The poller enqueues new candidates for
scoring, a `setInterval` worker drains the queue, ntfy fires for any score ≥ 8, and
`POST /api/scores/:id/feedback` records your 👍/👎. That's the "an 8+ pings your
phone before you open the dashboard" checkpoint.
