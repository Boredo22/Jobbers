# AI Models page + OpenRouter — pick a model per tier

Handoff spec for Claude Code. Written against the codebase as of commit
`fabdc53` (tailor-v2 step T1 committed; T2 in flight in the working tree —
**finish or commit tailor-v2 first, or do this work on a branch**). Follow the
house rules in `CLAUDE.md`: one step at a time, checkpoint before moving on,
teaching-mode explanation after each step, Biome + typecheck clean before each
commit.

---

## 1. The goal (owner's words, translated)

> "Add an AI Models page and use OpenRouter to select from a bunch of
> different models for both levels of complexity we currently have."

"Both levels of complexity" = the two `ModelTier`s in
`packages/ai/src/provider.ts`: **`small`** (bulk scoring — cheap/fast) and
**`large`** (tailor, resume review, profile synthesis — quality-critical).
Today each tier is hardcoded to one Anthropic model in
`packages/ai/src/models.ts` and only the Anthropic API / Claude CLI / Cowork
backends exist.

This spec adds:

1. A fourth provider backend, **`openrouter`** — one API key, hundreds of
   models (OpenAI, Google, Meta, DeepSeek, Anthropic included), selectable at
   runtime.
2. A DB-backed **tier → model** setting (which OpenRouter model serves `small`,
   which serves `large`).
3. An **AI Models page** in the web app: browse the OpenRouter catalog with
   live pricing, assign a model to each tier, save, and see actual usage/spend
   per model from the `ai_runs` ledger.

## 2. What exists today (read these before coding)

| Piece | Where | State |
|---|---|---|
| Provider contract | `packages/ai/src/provider.ts` | `AIProvider.complete<T>(req)` — one generic method; `tier: "small" \| "large"` on the request; `AIResult` carries tokens/model/duration |
| Tier → model map | `packages/ai/src/models.ts` | Hardcoded `MODELS` const (Haiku/Sonnet) + `PRICING` table + `estimateCostUsd()` |
| Anthropic backend | `packages/ai/src/providers/api.ts` | Forced **strict tool use** → Zod `safeParse` → one retry with validation errors fed back. This is the pattern to replicate. |
| Zod → JSON Schema | `packages/ai/src/schema.ts` | `toStrictInputSchema()` — reuse as-is |
| Composition root | `apps/api/src/lib/ai.ts` | `createProvider()` switches on `env.AI_PROVIDER`; `logAiRun()` writes the `ai_runs` ledger row (est. cost from `PRICING`) |
| Env gateway | `apps/api/src/lib/config.ts` | `AI_PROVIDER: z.enum(["api","cli","cowork"])`, `ANTHROPIC_API_KEY` optional |
| Call sites | `scoring/`, `tailor/`, `resume/`, `profile/` services + `scripts/score-one.ts` | Each does `const provider = createProvider()` then `provider.complete({ …, tier })` — **5 call sites**, all already inside async functions |
| Cost ledger | `aiRuns` in `apps/api/src/db/schema.ts` | feature / provider / model / tokens / estCost / durationMs — no schema change needed |
| Web shell | `apps/web/src/App.tsx` + `components/Layout.tsx` | Data-driven `NAV` array + route table; add one entry each |
| API client | `apps/web/src/lib/api.ts` | `apiGet` / `apiSend`, both Zod-validated |
| Settings storage | — | **Does not exist.** No settings/key-value table anywhere; this spec introduces one. |

## 3. Design decisions (the "why" — don't re-litigate, but do flag surprises)

- **OpenRouter is a fourth backend, not a replacement.** `AI_PROVIDER=openrouter`
  joins `api`/`cli`/`cowork` in the existing switch. Nothing about the
  `AIProvider` interface changes — that abstraction is doing exactly the job it
  was built for.
- **Which *backend* stays in `.env`; which *model* moves to the DB.** Backends
  involve secrets and process-level wiring — env is right for that. Model choice
  is user-editable data that the UI mutates at runtime — that's a DB row. So:
  `AI_PROVIDER` + `OPENROUTER_API_KEY` in env; the tier→model map in a new
  `app_settings` table. When `AI_PROVIDER` isn't `openrouter`, the page still
  works but shows a banner saying selections take effect when it is.
- **Plain `fetch`, no OpenAI SDK.** OpenRouter speaks the OpenAI-compatible
  `POST /api/v1/chat/completions` protocol, but we only need one endpoint and
  the house rule is "every external input crosses a Zod boundary" — a fetch +
  a Zod schema for the response envelope is fewer deps and *more* validated
  than an SDK's `any`-ish types. (`ApiProvider` uses the Anthropic SDK because
  strict tool use is genuinely fiddly there; the OpenAI wire shape is simple.)
- **Structured output = forced tool call, same as Mode A.** Send one
  `tools: [{ type: "function", function: { name, parameters: toStrictInputSchema(schema) } }]`
  with `tool_choice: { type: "function", function: { name } }`, parse
  `choices[0].message.tool_calls[0].function.arguments` (a JSON **string** —
  unlike Anthropic's already-parsed `input`), then the same Zod `safeParse` +
  one-retry-with-errors loop as `ApiProvider`. Also send
  `provider: { require_parameters: true }` so OpenRouter only routes to
  upstream providers that actually honor `tools` — without it, a request can
  land on a provider that silently ignores tool_choice.
- **The catalog is fetched live, never hardcoded.** `GET
  https://openrouter.ai/api/v1/models` is public (no key) and returns id, name,
  context length, per-token pricing, and `supported_parameters` for every
  model. The api proxies it (browser never talks to OpenRouter directly),
  validates with Zod, filters to models whose `supported_parameters` include
  `tools`, and caches in memory for ~1 hour (serve stale on refetch failure).
  Model slugs in this spec (e.g. `anthropic/claude-sonnet-5`) are **sketches —
  verify every default slug against the live catalog at build time**; per
  CLAUDE.md, docs/reality win over the plan's sketches.
- **Cost: prefer the provider's own number.** OpenRouter returns the actual
  charge when you send `usage: { include: true }` (response `usage.cost`, USD).
  Extend `AIResult` with optional `costUsd`; `logAiRun()` prefers it and falls
  back to `estimateCostUsd()` (which keeps working for Mode A). This kills the
  alternative of mirroring per-model prices into `PRICING` for hundreds of
  models — the ledger stays accurate with zero maintained price tables.
- **Settings storage is a generic `app_settings` key/value (jsonb) table**, not
  an `ai_model_settings` table with two columns. This is the app's first
  runtime setting but won't be the last; key/value + a Zod schema per key at
  the read boundary is the pattern that scales. Reads are one PK lookup per AI
  call — noise next to an LLM round-trip, so no cache/invalidation machinery.
- **Defaults keep today's behavior.** No settings row → the OpenRouter
  provider uses defaults equivalent to today's tiers (Haiku-class for `small`,
  Sonnet-class for `large`, via their OpenRouter slugs). First run is never
  surprising.
- **Non-goals (v2 if ever):** per-feature model overrides; switching
  `AI_PROVIDER` from the UI; streaming; OpenRouter fallback-model arrays;
  `openrouter/auto` routing; BYOK. Do not build these now.

## 4. Build steps

### Step M1 — packages/ai: `OpenRouterProvider` (+ smoke-test wiring)

**New file `packages/ai/src/providers/openrouter.ts`:**

```ts
export interface OpenRouterProviderOptions {
  apiKey: string;                        // injected — never read env here
  models: Record<ModelTier, string>;     // OpenRouter slugs, injected per-call-site
  baseUrl?: string;                      // default https://openrouter.ai/api/v1, overridable for tests
}
export class OpenRouterProvider implements AIProvider { … }
```

- `complete()` mirrors `api.ts`'s shape: resolve `models[req.tier]`, build the
  forced tool call (see design decisions), `fetch` with
  `Authorization: Bearer`, plus `HTTP-Referer` / `X-Title: Jobber` headers
  (OpenRouter attribution convention), `usage: { include: true }`,
  `max_tokens: req.maxTokens ?? 1024`.
- **Zod-validate the response envelope** (a `ChatCompletionSchema` local to
  this file: `choices[0].message.tool_calls[0].function.arguments` string,
  `usage` with `prompt_tokens`/`completion_tokens`/optional `cost`, `model`).
  A malformed HTTP body is a loud error, not an `undefined` five lines later.
- `JSON.parse` the arguments string inside a try/catch → treat parse failure
  like a validation failure (it counts as the one retry).
- Same two-attempt loop as `api.ts`: on `safeParse` failure, re-issue with the
  prettified errors appended; accumulate tokens across attempts; throw after
  attempt 2. Non-2xx HTTP → throw with status + response text (OpenRouter puts
  error detail in the JSON body — include it).
- Return `AIResult` + new optional field `costUsd` (sum across attempts).

**Contract + models changes:**

- `provider.ts`: add `costUsd?: number` to `AIResult` (doc-comment: actual
  provider-reported charge; absent when the backend can't report one).
- `models.ts`: add `OPENROUTER_DEFAULT_MODELS: Record<ModelTier, string>` —
  the Haiku/Sonnet OpenRouter slugs (**verify against the live catalog**, e.g.
  `anthropic/claude-haiku-4.5` / `anthropic/claude-sonnet-5` — check exact
  spelling at build time).
- `index.ts`: export the new provider, options type, and defaults.

**Vitest (`openrouter.test.ts`)** — mock `fetch` (inject via `baseUrl` +
`vi.stubGlobal` or pass-through; match house style in `cowork.test.ts`):
happy path returns parsed data + metering + `costUsd`; invalid-then-valid
retry accumulates tokens; invalid twice throws with the Zod errors;
malformed-JSON arguments consumes the retry; non-2xx throws with body text.

**API wiring for the smoke test (still M1):**

- `lib/config.ts`: `AI_PROVIDER` enum gains `"openrouter"`; new optional
  `OPENROUTER_API_KEY` (same `emptyAsUndefined` treatment as the Anthropic key).
- `lib/ai.ts`: `case "openrouter"` — throw a clear error without the key;
  construct with `models: OPENROUTER_DEFAULT_MODELS` for now (M3 makes this
  DB-driven). `logAiRun()`: use `result.costUsd ?? estimateCostUsd(…)`.
- `.env.example`: document `OPENROUTER_API_KEY` (get one at
  https://openrouter.ai/settings/keys; server-side only) and the new
  `AI_PROVIDER` option.

**✅ Checkpoint:** `pnpm -r test` and `pnpm -r typecheck` clean; then with
`AI_PROVIDER=openrouter` and a real key in `.env`,
`pnpm --filter api score:one` scores the fixture posting and the new `ai_runs`
row shows `provider = 'openrouter'`, an `anthropic/…` slug in `model`, and a
non-null `est_cost` that came from `usage.cost`.
Commit: `models: OpenRouterProvider — forced tool call + retry (step M1)`.

### Step M2 — API: the model catalog endpoint

**New module `apps/api/src/modules/models/`** (service + routes, registered in
`server.ts` like the others):

- `service.ts`: `fetchCatalog()` — GET `https://openrouter.ai/api/v1/models`
  (public, no key), Zod-validate the envelope (`data[]` with `id`, `name`,
  `context_length`, `pricing.prompt`/`pricing.completion` — **strings, USD per
  token**, so ×1e6 for the per-MTok display number — and
  `supported_parameters`). Filter to models supporting `tools`. Map to the
  lean shared shape (below). Module-level in-memory cache
  `{ data, fetchedAt }`, TTL 1 hour; on refetch failure serve stale if
  present, else 502.
- `routes.ts`: `GET /api/models` → `{ models: OpenRouterModel[], fetchedAt }`.

**Shared schema (`packages/shared/src/index.ts`):**

```ts
export const OpenRouterModelSchema = z.object({
  id: z.string(),            // the slug, e.g. "deepseek/deepseek-chat"
  name: z.string(),          // human label
  contextLength: z.number().nullable(),
  promptPerMTok: z.number(),     // USD per 1M input tokens
  completionPerMTok: z.number(), // USD per 1M output tokens
});
```

- **Vitest:** the raw-catalog → lean-shape mapper (string-price conversion,
  tools filtering) against a small fixture of the real response.

**✅ Checkpoint:** `curl localhost:3001/api/models` returns a few hundred
models with sane per-MTok prices (spot-check one against
https://openrouter.ai/models); a second curl within the hour is instant (cache
hit — confirm via no second fetch in api logs).
Commit: `models: OpenRouter catalog endpoint + 1h cache (step M2)`.

### Step M3 — DB settings + settings-driven provider

**Migration** (`drizzle-kit generate` → read the SQL → `migrate`):

```ts
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

**Shared schema:**

```ts
export const AiModelSettingsSchema = z.object({
  small: z.string().min(1),  // OpenRouter slug for the bulk tier
  large: z.string().min(1),  // OpenRouter slug for the quality tier
});
```

**Settings module (`apps/api/src/modules/settings/`):**

- `service.ts`: generic `getSetting(key, schema)` (row missing → null; jsonb
  crosses the Zod boundary on read — a corrupted row is a loud error) and
  `putSetting(key, value)` (upsert via `onConflictDoUpdate`, bump `updatedAt`).
  Then typed wrappers `getAiModelSettings()` / `putAiModelSettings()`.
- `routes.ts`:
  - `GET /api/settings/ai-models` → `{ settings: AiModelSettings | null, defaults: AiModelSettings }`
    (defaults from `OPENROUTER_DEFAULT_MODELS` so the UI can render the
    effective config before first save).
  - `PUT /api/settings/ai-models` — body `AiModelSettingsSchema`; **validate
    both slugs against the M2 catalog** (unknown or non-tools-capable model →
    400 naming the offending slug) before upserting. Returns the saved value.

**Provider becomes settings-aware (`lib/ai.ts`):**

- `createProvider()` → `async` (it now awaits one PK lookup in the
  `openrouter` case): `getAiModelSettings() ?? OPENROUTER_DEFAULT_MODELS` →
  inject into `OpenRouterProvider`. Other cases unchanged.
- Update the 5 call sites to `await createProvider()` (all already async).

- **Vitest:** settings service round-trip shape (or at minimum the
  merge-with-defaults logic); PUT rejection for an unknown slug.

**✅ Checkpoint:** `curl -X PUT localhost:3001/api/settings/ai-models -d
'{"small":"<cheap slug from /api/models>","large":"<flagship slug>"}'` →
200; re-run `score:one` → the `ai_runs` row's `model` is the slug you just
set, with cost reported. A bogus slug → 400 with a useful message.
Commit: `models: app_settings + DB-driven tier map (step M3)`.

### Step M4 — Web: the AI Models page

**Routing/nav:** `{ to: "/models", label: "AI Models" }` in `Layout.tsx`'s
`NAV` (between Resume and Settings) + the matching `<Route>` in `App.tsx` →
new `apps/web/src/pages/ModelsPage.tsx`.

**Data:** `useQuery` on `/api/models` and `/api/settings/ai-models` (Zod
schemas from `@jobber/shared` via the `apiGet` pattern); `useMutation` →
`apiSend("/api/settings/ai-models", "PUT", …)`, invalidating the settings
query on success + toast.

**Layout of the page:**

1. **Provider banner** — when the api reports the active backend isn't
   `openrouter`, an amber note: "AI_PROVIDER is `api` — selections below take
   effect when it's set to `openrouter` in `.env`." Expose the current
   provider by adding it to the GET response in M3
   (`{ settings, defaults, activeProvider: env.AI_PROVIDER }`) — one line.
2. **Two tier cards** (this is the heart of the page):
   - **Small — bulk scoring** ("dozens of postings per poll; cost matters") and
     **Large — quality work** ("tailor, resume review, profile synthesis;
     one human-gated call at a time").
   - Each card shows the currently effective model (saved or default, with a
     "default" badge when unsaved) with its per-MTok in/out prices and context
     length, and a **picker**: a text input filtering the catalog client-side
     (id + name substring match) over a scrollable list of rows —
     `name · slug · $in/$out per MTok · context`. Click a row to select it
     (hundreds of models — a filter input + list beats a giant `<select>`; no
     new component library needed).
   - A small "≈ cost per typical call" line under each selection, computed from
     catalog pricing (small: ~3k in / 300 out per scored posting; large: ~5k
     in / 3k out per tailor) — this makes the price difference between models
     concrete when choosing.
3. **Save bar** — Save button disabled until either tier differs from the
   effective config; on 400 (stale slug) surface the api's message.
4. **Usage table** — actual spend per model from the ledger. New endpoint in
   the models module: `GET /api/models/usage` → `ai_runs` grouped by
   `model` (drizzle `groupBy` + `sum`/`count`; remember `numeric` sums come
   back as **strings** — parse before display): calls, input/output tokens,
   total est. cost, last used. Render newest-first; this closes the loop —
   pick a model above, watch what it actually costs below.

**✅ Checkpoint (end-to-end):** open `/models` → see current defaults badged →
filter the catalog and pick a cheap model for `small` and a flagship for
`large` → Save → toast → run a score from Triage (or `score:one`) → the usage
table's top row shows the model you picked with a real cost. Reload → the
selection persisted. With `AI_PROVIDER=api`, the banner shows and saving still
works (settings are just data).
Commit: `models: AI Models page — catalog picker + usage ledger (step M4)`.

---

## 5. Guardrails (restating the house rules that bind here)

- **Keys stay server-side.** `OPENROUTER_API_KEY` lives in `.env`, is read only
  by `lib/config.ts`, and is injected into the provider. The browser talks
  only to `/api/*`; the catalog is proxied, never fetched from the frontend.
- **Every external input crosses a Zod boundary:** the chat-completion
  envelope, the tool-call arguments (then the *feature* schema on top), the
  public catalog, the `app_settings` jsonb on read, and both new request
  bodies. No `any` without a stated reason.
- **Cost stays auditable.** Every OpenRouter call lands in `ai_runs` with
  provider `openrouter`, the real slug, and provider-reported cost. The
  human-gated flows (tailor, resume review) keep their click-gates — changing
  models never changes *when* AI runs, only *which* model answers.
- **Docs win over sketches.** Endpoint shapes, `usage.include`,
  `require_parameters`, `supported_parameters` values, and every model slug in
  this spec must be verified against https://openrouter.ai/docs and the live
  catalog at build time.
- **Cheap-model reality check:** budget models are noticeably worse at strict
  schema-following; the retry loop absorbs occasional misses, but if a chosen
  `small` model fails validation twice the scorer surfaces the error rather
  than storing junk — that's working as designed. Note it in the teaching
  recap, not code.
- Teaching mode: after each step, explain the new concepts before proceeding —
  M1: implementing an interface a second time (why the abstraction pays off),
  `fetch` + Zod vs. an SDK, mocking `fetch` in Vitest; M2: in-memory caching
  and stale-on-error; M3: key/value settings with per-key schemas, jsonb,
  upsert (`onConflictDoUpdate` vs. Postgres `ON CONFLICT`); M4: dependent
  queries, mutation → invalidation, client-side filtering of a large list.
