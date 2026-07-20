# Step 2.1 — The AI provider interface: study notes

> Phase 2 begins. This step writes almost no runtime code — it defines a
> *contract*. Written for a junior dev coming from Python: every TypeScript term
> (interface, generic, `import type`) gets defined the first time it appears, and
> the design *decision* matters more than the handful of lines. By the end you
> should be able to explain why `packages/ai` exposes one generic `complete`
> method instead of `scoreJob()`/`reviewResume()`, and defend it in an interview.

**Deliverable:** a new workspace package `@jobber/ai` with a single file that
matters — [`provider.ts`](../../packages/ai/src/provider.ts) — declaring the
`AIProvider` interface that every AI backend will implement. No API calls yet;
that's step 2.2. This step is the *shape of the door* the three providers will
all fit through.

```
apps/api  (scoring, resume review, …)      ← depends only on the interface
     │
     ▼
@jobber/ai  ──  AIProvider (this step)
     ▲   ▲   ▲
     │   │   └── CoworkProvider  (Mode C, step 3.3)  file queue
     │   └────── CliProvider     (Mode B, step 3.3)  shells out to `claude`
     └────────── ApiProvider     (Mode A, step 2.2)  Anthropic Messages API
```

Files added this step:

```
packages/ai/
├── package.json          # new workspace pkg @jobber/ai, entry = raw TS source
├── tsconfig.json         # extends the base, same as @jobber/shared
└── src/
    ├── provider.ts       # the AIProvider interface + AIRequest/AIResult/ModelTier
    └── index.ts          # barrel: consumers import from "@jobber/ai", not deep paths
```

---

## Part 0 — Vocabulary you need first

- **Interface:** a TypeScript type that describes the *shape* of an object —
  which properties and methods it has — without any implementation. Purely a
  compile-time thing; it disappears from the emitted JavaScript. The closest
  Python analog is `typing.Protocol` (structural) or an abstract base class.
- **Implements:** a class or object *satisfies* an interface when it has every
  member the interface requires. In TS this is mostly structural — if the shape
  matches, it fits, no explicit `implements` keyword needed (though you can add
  one for clarity/errors).
- **Generic / type parameter (`<T>`):** a type *variable*. A function or type
  written once that works for many concrete types, with the compiler filling in
  `T` at each call site. Python 3.12+ has the same idea: `def f[T](x: T) -> T`.
- **`import type`:** an import used only in type positions. It's erased at compile
  time, so it emits no `require`/`import` in the JS. Signals intent and prevents
  accidental runtime coupling / import cycles.
- **Barrel file:** an `index.ts` that re-exports a package's public surface, so
  consumers write `import { X } from "@jobber/ai"` instead of reaching into
  `@jobber/ai/src/provider`. One front door, internals free to move.
- **Dependency inversion:** high-level code (the scoring feature) depends on an
  *abstraction* (the interface), not a *concrete* implementation. Swapping the
  implementation then can't break the caller. This step is that principle made
  literal.

---

## Part 1 — Why a whole package for "call an LLM"

The naive version is: in the scoring code, `import Anthropic from "@anthropic-ai/sdk"`
and call it directly. It would work. But the plan (PLAN.md) commits to **three
ways** of reaching a model over the project's life:

- **Mode A** — the Anthropic API directly (needs an API key, costs money per call).
- **Mode B** — shelling out to the `claude` CLI (runs where Claude Code is already
  logged in — the homelab — so no separate key/billing).
- **Mode C** — writing request files to a queue that a Cowork session drains.

If the SDK call were baked into the scoring module, supporting Modes B and C would
mean rewriting scoring. Instead we define **one contract** and make scoring depend
on *that*. Picking a backend becomes a config line (`AI_PROVIDER=cli`), not a code
change. That's dependency inversion, and it's the reason this step exists before
any real call is written.

---

## Part 2 — The interface, line by line (`provider.ts`)

```ts
export interface AIProvider {
  complete<T>(req: AIRequest<T>): Promise<AIResult<T>>;
}
```

That's the entire contract: **one method**. Read it as "give me a request, I'll
give you a validated result, asynchronously." Everything else in the file is the
shape of the request and the result.

### 2.1a One generic method, not many named ones — the key decision

The tempting alternative is a fat interface:

```ts
interface AIProvider {
  scoreJob(jd: string): Promise<FitScore>;
  reviewResume(text: string): Promise<ResumeReview>;
  // …one method per feature
}
```

We deliberately did **not** do this. Why: every new feature would force all three
providers to grow a new method, and the file-queue provider (Mode C) would have to
re-encode each feature's logic. Instead, features live in the *api* — the scoring
module builds its own prompt and passes its own schema in — and `packages/ai`
stays **feature-agnostic**: it knows only "text in, schema-shaped value out." It
has never heard of a job or a resume.

The payoff shows up in Mode C: since a request is just `{ prompt, schema, tier }`,
the queue provider can serialize it to a JSON file with almost no code. A
feature-aware interface could never be that simple.

> **Interview one-liner:** *"I put a single generic `complete(prompt, schema)` on
> the provider instead of per-feature methods, so the AI package stays agnostic
> and the third (file-queue) backend became trivial to write."*

### 2.1b `AIRequest<T>` — and how the schema drives the type

```ts
export interface AIRequest<T> {
  prompt: string;
  schema: z.ZodType<T>;   // ← the star of the show
  schemaName: string;
  maxTokens?: number;
  tier: ModelTier;
}
```

`schema: z.ZodType<T>` is the line to understand deeply. A Zod schema isn't just a
runtime validator — its TypeScript type carries what it validates. So when a caller
writes `complete({ schema: FitScoreSchema, … })`, the compiler *infers* `T = FitScore`
from the schema, with no annotation. That inferred `T` then flows into the return
type `Promise<AIResult<T>>`, so `result.data` is typed `FitScore` — no casts, no
`any`. **The schema is simultaneously the runtime validator and the source of the
static type.** This is the `schema → z.infer` spine from Phase 0, now doing double
duty as a generic driver.

`schemaName` is separate because JSON-Schema conversion (step 2.2) throws away the
name; the provider needs it to name the "tool" it forces the model to call.

### 2.1c `ModelTier` — intent, not model IDs

```ts
export type ModelTier = "small" | "large";
```

Callers say *what kind* of work this is, not *which model* to use:
- `"small"` — bulk, cost-sensitive (scoring dozens of postings).
- `"large"` — quality-critical (resume review, profile synthesis).

The mapping from tier → concrete model ID (`claude-…`) lives in config, filled in
at step 2.2. So when a model gets renamed or you switch the cheap tier to a new
model, you edit *one config line*, not every call site. Same instinct as the `env`
gateway in Phase 1: push volatile facts to one edge and keep the core stable.

### 2.1d `AIResult<T>` — the value *and* the receipt

```ts
export interface AIResult<T> {
  data: T;              // validated output
  inputTokens: number;
  outputTokens: number;
  model: string;
  durationMs: number;
}
```

Every call returns the answer **plus its metering**: tokens in/out, which model
served it, how long it took. Those fields map one-to-one onto an `ai_runs` row (the
cost ledger already in the DB schema from step 1.1). Building the receipt into the
return type means *no call can succeed without producing the data to audit it* —
the cost-awareness story is structural, not bolted on later.

---

## Part 3 — The small stuff that's still worth noticing

- **`import type { z } from "zod"`.** We only use `z` in type positions
  (`z.ZodType<T>`), so the type-only import is erased from the compiled JS. Habit
  worth forming: if you import something purely for its type, say so.
- **`package.json` entry points at raw TS.** `"main": "./src/index.ts"` — same
  trick as `@jobber/shared`. Vite and tsx consume TypeScript from workspace
  packages directly, so `@jobber/ai` needs no build step in dev. (The production
  bundler inlines it later, step 8.1.)
- **`"@jobber/shared": "workspace:*"`.** The `workspace:*` protocol tells pnpm
  "resolve this from inside the monorepo, always the local copy," never npm.
  `@jobber/ai` will lean on shared's schemas (`FitScoreSchema` lands next step).
- **Barrel export (`index.ts`).** Re-exports the four types so consumers import
  from `"@jobber/ai"`. The interface's internals can be reshuffled without
  touching a single import elsewhere.

---

## Part 4 — How you verify it (the checkpoint)

Step 2.1 has **no runtime checkpoint** — it's a contract, there's nothing to run
yet (the first real "score a live JD" checkpoint is step 2.2). What you *can*
verify is that the package is wired correctly:

```bash
pnpm install                              # picks up the new workspace package
pnpm --filter @jobber/ai exec tsc --noEmit   # → clean typecheck
pnpm biome check packages/ai              # → no lint errors
```

All three pass. The installed SDK versions resolved to real releases
(`@anthropic-ai/sdk` 0.72.1, `zod-to-json-schema` 3.25.2) — those get exercised for
the first time in step 2.2.

---

## What's next — Step 2.2 (`ApiProvider`, Mode A)

The first concrete implementation of this interface: a real Anthropic Messages API
call using **forced tool use** to guarantee schema-shaped output (declare one tool
whose `input_schema` is our Zod schema converted via `zod-to-json-schema`, set
`tool_choice` to force it, read the arguments back). Wrapped with `safeParse` →
one retry on failure → throw, and every success logged to `ai_runs`. That step
needs an `ANTHROPIC_API_KEY` in `.env`, and its checkpoint is a scratch script that
scores one hardcoded job description into a valid `FitScore`.
