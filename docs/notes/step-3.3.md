# Step 3.3 — Alternate providers: CLI (Mode B) and Cowork (Mode C)

> The payoff of a decision made back in step 2.1. Every AI feature — scoring,
> resume review, profile proposal, tailoring — calls one interface, `AIProvider`,
> and never a concrete backend. This step adds the second and third
> implementations of that interface, so the *same* calls can run with **no API
> key**: `CliProvider` shells out to the logged-in `claude` CLI, and
> `CoworkProvider` exchanges files with a Cowork session. Not one feature module
> changed — flipping `AI_PROVIDER` in `.env` is the whole switch. Written for a dev
> from Python: this is the Strategy pattern / dependency injection, and the
> interesting engineering is "how do you get *structured* output from a backend
> that can't force tool use?"

**Deliverable:** `AI_PROVIDER=cli` or `AI_PROVIDER=cowork` makes the app score and
tailor jobs without ever touching `ANTHROPIC_API_KEY`.

```
                       ┌──────────────── AIProvider (interface, step 2.1) ───────────────┐
scoring / tailor / …──▶│  ApiProvider (A)      CliProvider (B)      CoworkProvider (C)    │
                       │  forced tool use      `claude -p`          ai-queue/ files       │
                       └────────────────────────────────────────────────────────────────┘
                                     ▲ shared: toJsonSchema, runStructured (extract+validate+retry)
```

Files added / changed:

```
packages/ai/src/schema.ts              # ★ toJsonSchema / toStrictInputSchema (extracted from api.ts)
packages/ai/src/providers/structured.ts# ★ buildStructuredPrompt, extractJson, runStructured (shared)
packages/ai/src/providers/cli.ts       # CliProvider (Mode B)
packages/ai/src/providers/cowork.ts    # CoworkProvider (Mode C)
packages/ai/src/providers/api.ts       # now imports toStrictInputSchema (de-duplicated)
packages/ai/src/index.ts               # export the two new providers
packages/ai/src/providers/{structured,cowork}.test.ts   # offline round-trip + parsing tests
apps/api/src/lib/ai.ts                 # createProvider(): cli / cowork cases
apps/api/src/lib/config.ts             # CLAUDE_BIN, AI_QUEUE_DIR
.env.example                           # document cli/cowork
ai-queue/README.md                     # instructions the Cowork session follows
```

---

## Part 0 — Vocabulary you need first

- **Forced tool use vs prompt-instructed JSON.** Mode A guarantees shape by making
  the model "call a tool" whose schema *is* your Zod schema (step 2.2). The CLI and
  Cowork backends only give back **text** — they can't force a tool — so they get
  the schema a weaker way: it's written into the prompt and the model is *asked* to
  return matching JSON. Weaker guarantee ⇒ we parse and re-validate ourselves.
- **The `claude` CLI print mode.** `claude -p --output-format json` runs one prompt
  non-interactively and prints a JSON *envelope* (`{ result, usage, … }`) where
  `result` is the assistant's text. It runs against whatever account Claude Code is
  logged into — hence no API key.
- **File-queue RPC.** Two processes communicate by writing/reading files in agreed
  folders: a request in `pending/`, an answer in `done/`. Old, boring, and exactly
  right when the "worker" is a human-driven Cowork session.

---

## Part 1 — Don't repeat the schema conversion (`schema.ts`)

Before adding providers, one refactor. `ApiProvider` had the Zod→JSON-Schema logic
inline. All three providers need it, so it moves to `schema.ts` with two exports:

- `toStrictInputSchema` — for Mode A's *strict* tool use, which rejects a handful
  of JSON-Schema keywords (`minimum`, `minItems`, …), so they're stripped.
- `toJsonSchema` — the **full** schema (bounds and all), embedded in the prompt for
  CLI/Cowork. There the extra constraints are useful *instructions* to the model,
  not a problem, so we keep them.

Same instinct as `models.ts` and the env gateway: the thing more than one caller
needs lives in exactly one place.

---

## Part 2 — The shared reliability envelope (`structured.ts`)

This is the heart of the step. Getting schema-shaped output from a text-only
backend is the same three-step dance regardless of *which* backend, so it's
written once and both providers borrow it:

```ts
runStructured(req, invoke):           // invoke: (prompt) => Promise<{text, tokens, model}>
  prompt = buildStructuredPrompt(req) // append the JSON Schema + "return ONLY JSON"
  for attempt in 1..2:
    text = await invoke(prompt)       // ← the ONLY provider-specific part
    json = extractJson(text)          // tolerate prose / ```fences / prefix
    if schema.safeParse(json) ok: return AIResult(data, tokens, model, durationMs)
    else: prompt += the validation errors   // one retry, errors fed back
  throw
```

Two pieces to really absorb:

- **`extractJson` is deliberately forgiving.** Models wrap JSON in prose or ```json
  fences no matter how firmly you say not to. So it: strips a fenced block if
  present, tries a whole-string `JSON.parse`, and otherwise scans for the first
  **balanced** `{ … }` — tracking string state so a `}` *inside* a string value
  doesn't end the object early. That string-awareness is the subtle bit (a resume
  bullet like `"weights like {a}"` would otherwise break a naive brace counter).
  It's unit-tested against all these cases.
- **`runStructured` reproduces `ApiProvider`'s contract exactly** — same one-retry,
  same token accumulation across attempts, same "throw with the prettified errors."
  That's what lets a caller stay ignorant of which provider it got: all three
  succeed, retry, and fail identically.

`invoke` is the seam. Mode B's invoke shells out; Mode C's writes a file and waits.
Everything else is shared.

---

## Part 3 — CliProvider (Mode B) (`cli.ts`)

```ts
const child = spawn(claudeBin, ["-p", "--output-format", "json"], {stdio:["pipe","pipe","pipe"]});
child.stdin.write(prompt); child.stdin.end();   // prompt via STDIN
// on close: JSON.parse(stdout) → envelope; return { text: env.result, tokens: env.usage, model }
```

Points that matter:

- **Prompt over STDIN, not argv.** A JD + resume + schema is easily tens of KB;
  passing that as a command-line argument risks the OS arg-length limit (`E2BIG`)
  and leaks the prompt into the process table. Piping to stdin sidesteps both. This
  is why the plan specifies stdin explicitly.
- **The envelope crosses a Zod boundary too.** `CliEnvelopeSchema` is lenient
  (`.passthrough()`, all fields optional) — the CLI adds fields across versions and
  we only read `result`/`usage`/`model` — but it's still parsed, not trusted raw
  (CLAUDE.md §4: *every* external input, and a subprocess's stdout is one).
- **Clear failure modes.** `spawn` error → "is Claude Code installed and logged
  in?" (that's what `ENOENT` means here); non-zero exit → include stderr;
  `is_error` in the envelope → surface it. A provider that fails opaquely is worse
  than no provider.
- **Model + cost.** We log the model the CLI reports if present, else fall back to
  the tier's model id so the `ai_runs` cost estimate still resolves. The CLI's real
  spend is your subscription — logging the **API-equivalent** cost is what makes the
  Mode A vs Mode B comparison meaningful.

---

## Part 4 — CoworkProvider (Mode C) (`cowork.ts`) — and a deliberate deviation

Mode C has no API and no CLI. `complete()` drops a request file; a separate Claude
Cowork session (with the `ai-queue/` folder connected) answers it; we ingest the
answer.

```
complete(): write ai-queue/pending/<id>.json   {id, schemaName, prompt, jsonSchema, meta}
            poll  ai-queue/done/<id>.json until it appears (or timeout)
            validate result → delete both files → return AIResult
```

**The deviation, stated plainly** (the interesting judgement call of this step): the
plan sketches an *asynchronous* Mode C — `complete()` returns a "pending" marker
immediately and a `chokidar` watcher ingests results later. I didn't build that,
because it **breaks the `AIProvider` contract**: the interface promises an
`AIResult<T>`, and a "pending, no data yet" outcome would force every caller
(scoring worker, tailor, review) to learn a third case. Instead this is a
**synchronous file-RPC**: write the request, then poll for the answer with a
timeout. Same *intent* — batch the same calls through a Cowork run, compare
cost/latency — but it slots into the existing worker with zero caller changes.

> **Interview-ready framing:** *"The plan wanted an async, watcher-based queue. I
> chose a synchronous file-RPC because it satisfies the existing provider interface
> without leaking a 'pending' state into every consumer. It's the right trade for
> a homelab batch tool; the async version — decouple submit from ingest so the
> worker never blocks — is the correct Phase-4 upgrade if throughput ever matters."*

Details that make it correct, not just plausible:

- **Atomic writes.** The request is written to `.<id>.tmp` then `rename`d to
  `<id>.json`. Rename is atomic on a POSIX filesystem, so a reader can never catch a
  half-written request. (A watcher-based reader would otherwise race the writer.)
- **String-awareness reused.** The Cowork answer's `result` may be a JSON object or
  a JSON string; we stringify objects and feed the text through the same
  `extractJson` → `runStructured` path as the CLI. One reliability envelope, both
  providers.
- **Cleanup + timeout.** On ingest we delete both files (the queue then shows only
  live work); on timeout we delete the stale request and throw a clear "is a Cowork
  session processing pending/?" error.
- **Chokidar not needed.** The plan lists `chokidar` for the async watcher; a
  synchronous provider just polls with `fs.readFile` in a bounded loop, so it ships
  with **zero new dependencies**.

`ai-queue/README.md` is committed (the folders are gitignored — they hold transient
job data): it tells the Cowork session the exact request/response file shapes so it
can process a batch unattended.

---

## Part 5 — Wiring: one switch, no caller changes (`lib/ai.ts`)

```ts
switch (env.AI_PROVIDER) {
  case "api":    return new ApiProvider({ apiKey: env.ANTHROPIC_API_KEY });
  case "cli":    return new CliProvider({ claudeBin: env.CLAUDE_BIN });
  case "cowork": return new CoworkProvider({ queueDir: resolve(env.AI_QUEUE_DIR) });
}
```

This is the entire integration surface. `createProvider()` is the **composition
root** — the one place that knows which concrete class is live. Because the switch
is exhaustive over the `AI_PROVIDER` enum, TypeScript proves every case returns and
no `default` is needed; add a fourth mode later and the compiler flags this switch
until you handle it. That the feature modules didn't change *at all* is the whole
thesis of step 2.1 finally cashed in.

---

## Part 6 — How you verify it (the checkpoint)

**Offline (already done, no setup):** `pnpm --filter @jobber/ai test` runs 18 tests,
including a real `CoworkProvider` round-trip in a temp dir (write request → answer →
validate → cleanup) and the `extractJson` edge cases. This proves the shared
envelope and Mode C's file logic without a DB, key, or CLI.

**Mode B (needs Claude Code installed + logged in on this machine):**
1. `AI_PROVIDER=cli` in `.env` (no `ANTHROPIC_API_KEY` required).
2. `pnpm --filter api score:one` — the existing scorer script calls `createProvider()`,
   so it now runs through the CLI. You should get a valid `FitScore` and an
   `ai_runs` row with `provider='cli'`.

**Mode C (needs a Cowork session):**
1. `AI_PROVIDER=cowork` in `.env`. Start a scoring/tailor action (or `score:one`) —
   it writes `ai-queue/pending/<id>.json` and waits.
2. In a Claude Cowork session with the repo's `ai-queue/` folder connected, follow
   `ai-queue/README.md`: read each `pending/` file, answer into `done/`.
3. The waiting call ingests the answer and returns; an `ai_runs` row shows
   `provider='cowork'`.

**The artifact:** score the same batch under `api` and `cli` (or `cowork`), then
`select provider, count(*), avg(duration_ms), sum(est_cost) from ai_runs group by
provider;`. That cost/latency table across backends is the interview-gold evidence
the plan calls for.

That's the checkpoint: *the same scoring and tailoring code runs through three
completely different backends, selected by one env var, and the cost ledger proves
it.* **Phase 3 done.**
