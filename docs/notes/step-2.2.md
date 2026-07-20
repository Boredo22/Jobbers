# Step 2.2 — ApiProvider (Mode A): forced structured output

> The first *real* AI call. Step 2.1 defined the `AIProvider` contract; this step
> writes the first backend that satisfies it — a live Anthropic Messages API call
> that is guaranteed to return a value shaped like a Zod schema. Written for a
> junior dev coming from Python: the one hard idea here (forced tool use) gets
> built up from scratch, and every new library call is explained. By the end you
> should be able to explain how we make an LLM return valid structured data
> reliably, and why the cost of each call lands in a database ledger.

**Deliverable:** running `pnpm --filter api score:one` (with an `ANTHROPIC_API_KEY`
set) scores a hardcoded job description against a tiny candidate profile, prints a
validated `FitScore`, and writes one row to the `ai_runs` cost ledger.

```
score-one.ts ─▶ createProvider() ─▶ ApiProvider.complete({ prompt, schema })
                                          │
                                          ├─ Zod schema ──z.toJSONSchema──▶ tool input_schema
                                          ├─ Messages API call, tool_choice forces the tool
                                          ├─ read tool_use.input ──safeParse──▶ FitScore  (retry once on failure)
                                          └─ returns AIResult { data, tokens, model, ms }
                                                   │
                                          logAiRun("score", result) ─▶ INSERT ai_runs (feature, model, tokens, est_cost, ms)
```

Files added / changed this step:

```
packages/shared/src/index.ts       # + FitScoreSchema (the LLM output contract)
packages/ai/src/
├── models.ts                      # tier→model map + price table + estimateCostUsd()
├── providers/api.ts               # ApiProvider — forced tool use + safeParse + retry
└── index.ts                       # export the above
apps/api/src/
├── lib/config.ts                  # + ANTHROPIC_API_KEY, AI_PROVIDER env
├── lib/ai.ts                      # createProvider() + logAiRun()  (the api's AI wiring)
└── scripts/score-one.ts           # the checkpoint script
.env.example                       # + ANTHROPIC_API_KEY, AI_PROVIDER
```

---

## Part 0 — Vocabulary you need first

- **Messages API:** Anthropic's single HTTP endpoint for talking to a model. You
  POST a list of messages (and optionally tools); it returns the model's reply as
  a list of *content blocks*.
- **Content block:** one piece of a reply. A reply is an array of blocks, each
  tagged by `type` — `"text"` for prose, `"tool_use"` when the model calls a tool.
  It's a discriminated union; you narrow on `.type` before reading the payload.
- **Tool (function calling):** a capability you *describe* to the model with a
  name and a JSON Schema for its arguments. The model can then emit a `tool_use`
  block containing arguments that match that schema. Normally the model *chooses*
  whether to call a tool.
- **`tool_choice`:** the knob that removes the choice. `{ type: "tool", name }`
  *forces* the model to call that specific tool — so its reply must be a
  `tool_use` block with schema-shaped arguments. This is the whole trick (Part 2).
- **JSON Schema:** a language-neutral way to describe the shape of JSON data
  (`{"type":"object","properties":{...},"required":[...]}`). The tool's
  `input_schema` is JSON Schema; our Zod schema gets converted into it.
- **`safeParse`:** Zod's non-throwing validate. Returns `{success:true, data}` or
  `{success:false, error}` — so we can branch and retry instead of crashing.
- **Token:** the unit models bill in (~¾ of a word). Every call reports
  `input_tokens` and `output_tokens`; multiply by the price-per-million to get cost.
- **Ledger (`ai_runs`):** an append-only table, one row per AI call, recording
  feature/model/tokens/cost/duration. The project's "I was cost-aware" evidence.

---

## Part 1 — `FitScoreSchema`: the output contract (shared)

Before we can force structured output, we need to define the structure. It's a
Zod object in `@jobber/shared` — the same `schema → z.infer` spine as every other
entity:

```ts
export const FitScoreSchema = z.object({
  score: z.number().min(0).max(10).describe("Overall fit, 0–10. Anchors: 5 = ..."),
  matchPoints: z.array(z.string()).describe("Concrete reasons this role fits..."),
  gaps: z.array(z.string()).describe("Concrete mismatches or risks..."),
  credentialGapFlag: z.boolean().describe("True if the posting hard-requires..."),
  rationale: z.string().describe("2–4 sentence plain-English explanation..."),
});
export type FitScore = z.infer<typeof FitScoreSchema>;
```

Two things worth noticing:

- **It maps onto the `fit_scores` table** from step 1.1 (score, matchPoints, gaps,
  credentialGapFlag, rationale). One shape, defined once, used as the LLM contract
  *and* the DB row.
- **`.describe()` is load-bearing, not a comment.** When we convert this schema to
  JSON Schema, each `.describe()` string becomes the `description` of that field —
  and the model reads those. So the score anchors ("5 = plausible with gaps, 8 =
  strong match") are delivered to the model *through the schema itself*, not just
  the prompt. This is why LLM scores cluster at 7 without anchors: give the model
  a rubric where it's looking.

---

## Part 2 — Forced tool use: the reliable-structured-output trick

This is the heart of the step. **Problem:** an LLM returns free text. If you just
ask "reply with JSON", it *usually* complies — but sometimes it adds a preamble
("Here's the JSON:"), wraps it in a code fence, or drifts the shape. Parsing that
is a losing battle.

**The trick:** models are trained to call tools with arguments that match a schema
*exactly*. So we turn "give me structured output" into "call this one tool":

1. **Declare one tool** whose `input_schema` is our Zod schema, converted to JSON
   Schema:
   ```ts
   const tool = { name: "fit_score", description: "...", input_schema: toInputSchema(schema) };
   ```
2. **Force it** with `tool_choice`:
   ```ts
   tool_choice: { type: "tool", name: "fit_score" }
   ```
   Now the model *cannot* reply with prose — it must emit a `tool_use` block whose
   `input` matches the schema.
3. **Read the arguments back** from that block — `res.content.find(b => b.type ===
   "tool_use").input` — and that `input` is our structured object.

```ts
const res = await this.client.messages.create({
  model, max_tokens,
  tools: [tool],
  tool_choice: { type: "tool", name: req.schemaName },  // ← forces the shape
  messages: [{ role: "user", content: prompt }],
});
const block = res.content.find((b) => b.type === "tool_use");
```

### 2.2a Converting Zod → JSON Schema (a plan deviation, and why)

The plan sketched using the `zod-to-json-schema` npm package. But that library
targets Zod v3, and this project is on **Zod v4 — which ships conversion natively**
as `z.toJSONSchema(schema)`. Per the house rule ("install current stable; docs win
over the plan's sketch"), we use the built-in and dropped the extra dependency.

```ts
function toInputSchema(schema: z.ZodType): Anthropic.Tool.InputSchema {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;                 // the tool API doesn't expect this meta key
  return json as Anthropic.Tool.InputSchema;
}
```

Verified output for `FitScoreSchema`: a clean object schema with every
`.describe()` carried through, `required` listing all fields, and
`additionalProperties:false`. Exactly what a tool wants.

### 2.2b Why forced tool use over "native structured outputs"

Anthropic now also has native structured outputs (`output_config.format`). We
chose forced tool use anyway because it's the most **forgiving of rich schemas**:
native structured outputs rejects things like `minimum`/`maximum` and demands
strict JSON-Schema shapes, whereas a tool's `input_schema` happily accepts our
`score: 0–10` bounds and descriptions as-is. For a schema with human-readable
anchors baked in, forced tool use is the lower-friction path. (Interview-ready
tradeoff: *"I used forced tool use because my schema carries min/max and rich
descriptions the model should see; native structured outputs would have stripped
or rejected them."*)

---

## Part 3 — Validate at the edge, then retry once (`api.ts`)

The model is *forced* to emit the tool, but it can still fudge a value (return
`score: 11`, or a number as a string). CLAUDE.md §4 — *every external input
crosses a Zod boundary* — applies squarely: the model's output is external input.
So we don't trust the tool's `input`; we `safeParse` it with the same schema:

```ts
const parsed = req.schema.safeParse(block?.input);
if (parsed.success) return { data: parsed.data, ... };   // validated — hand it back
```

On a validation miss, we **retry exactly once**, feeding the model its own errors:

```ts
const errors = z.prettifyError(parsed.error);   // human-readable list of what failed
if (attempt === 2) throw new Error(`... failed validation after retry:\n${errors}`);
prompt = `${req.prompt}\n\nYour previous response failed validation:\n${errors}\n\nReturn a corrected result.`;
```

Design choices worth internalizing:

- **One retry, then throw.** Not an infinite loop — a persistently-invalid model
  is a real error the caller must see (and log a failed run for), not something to
  paper over forever.
- **A fresh single-turn request on retry, not a tool-result continuation.**
  Continuing the tool conversation would force us to satisfy the API's
  `tool_use`/`tool_result` pairing rules. Re-asking from scratch with the errors
  appended is simpler and just as effective.
- **Tokens accumulate across attempts.** The `AIResult` reports the *total* tokens
  spent getting a valid answer, retry included — so the cost ledger tells the
  truth, not just the cost of the lucky final call.

---

## Part 4 — `models.ts`: tiers, model IDs, and the price table

`packages/ai` never hardcodes a model name at a call site — the scorer asks for
tier `"small"`. This file is the *only* place tiers resolve to concrete models,
and the only place prices live:

```ts
export const MODELS = { small: "claude-haiku-4-5", large: "claude-sonnet-5" };
export const PRICING = {
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },   // USD per 1M tokens
  "claude-sonnet-5":  { input: 3.0, output: 15.0 },
};
export function estimateCostUsd(model, inTok, outTok) {
  const p = PRICING[model];
  if (!p) return null;                                 // unknown model → null, not a fake $0
  return (inTok / 1e6) * p.input + (outTok / 1e6) * p.output;
}
```

Same instinct as the env gateway in Phase 1: **push the volatile facts to one
edge.** A model rename or a price change is a one-file edit; nothing at a call
site knows or cares. The `null`-on-unknown-model choice matters — silently pricing
an unrecognized model at `$0` would quietly corrupt the cost story; a `null` makes
the gap visible (stored as SQL `NULL`).

---

## Part 5 — Where the pieces meet: `lib/ai.ts` (the api's job, not the library's)

`packages/ai` is a **pure library** — it reads no env and touches no database.
That's deliberate (it's what makes it testable and reusable for the CLI/Cowork
providers later). So the api needs one small file where library meets app:

- **`createProvider()`** reads the validated `env`, and for `AI_PROVIDER=api`
  builds `new ApiProvider({ apiKey: env.ANTHROPIC_API_KEY })`. The key is *injected*
  — the library never reaches for `process.env`. When Phase 3 adds `cli`/`cowork`,
  they slot into this `switch` and **no caller changes** (the payoff of the
  step-2.1 interface).
- **`logAiRun(feature, result)`** owns the ledger write: it calls
  `estimateCostUsd` and inserts the `ai_runs` row. One Drizzle gotcha handled here
  — the `numeric` money column takes a **string** in Drizzle (to keep cents exact,
  no float drift), so we `cost.toFixed(6)`.

This split — pure library, thin app-side wiring — is the same dependency-inversion
idea from step 2.1, now made concrete: the *volatile* stuff (env, DB, cost table)
lives in the app; the *reusable* stuff (how to call a model) lives in the package.

---

## Part 6 — The API key never touches the browser

`ANTHROPIC_API_KEY` is added to the env gateway as **optional** (so the server and
one-off scripts boot without it; the provider throws a clear error only when
actually used without a key). It lives in `.env` (gitignored) and is read only by
the API process. The browser talks to *our* API, never to Anthropic — CLAUDE.md
§5. A leaked model key is a real bill someone else can run up; keeping it
server-only is non-negotiable, and the architecture (browser → our API → model)
enforces it structurally.

---

## Part 7 — How you verify it (the checkpoint)

This one costs a fraction of a cent to run and needs your key.

1. **Get a key** at <https://console.anthropic.com>, and put it in `.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
2. **Make sure Postgres is up** (`docker compose up -d db`) — the script writes an
   `ai_runs` row.
3. **Run it:**
   ```
   pnpm --filter api score:one
   ```
   Expect a printed `FitScore` (this AI-Solutions-Engineer role should score high
   for the sample candidate — remote, Python, no-degree-required, comp above the
   floor — with `credentialGapFlag: false`), followed by a metering line.
4. **Confirm the ledger row:**
   ```
   docker compose exec db psql -U jobber -c \
     "select feature, model, input_tokens, output_tokens, est_cost, duration_ms from ai_runs order by created_at desc limit 1;"
   ```
   You should see one `score` row with sane token counts and a sub-cent `est_cost`.

That's the checkpoint: *a real job description, scored into valid structured data
by a live model, with the cost recorded.*

---

## What's next — Step 2.3 (prompts as versioned files)

The prompt in `score-one.ts` is inline and minimal on purpose. Step 2.3 moves it
into a versioned file (`packages/ai/prompts/score-job.v1.md`) with `{{jd}}`,
`{{resume}}`, `{{profile}}` placeholders and a tiny `renderPrompt` helper, and
stores the prompt version on each `fit_scores` row — so when you tune the prompt,
old scores stay interpretable. Then step 2.4 wires real scoring into the poller.
