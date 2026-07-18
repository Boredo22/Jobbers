# Jobber — Detailed Implementation Plan

Companion to `Jobber_App_Build_Plan.md` (the "what & why"). This is the "how": step-by-step, with the exact libraries, commands, file layout, and key functions per step. Read it before handing it to Claude Code; each step ends with a **✅ Checkpoint** — a concrete thing you can verify yourself before moving on. Written July 2026; where versions drift, the instruction to Claude Code is always "install current stable and check the official docs," so nothing here should rot badly.

---

## 0. How to run this build with Claude Code

1. **Put the plan in the repo.** Create the repo first, copy this file to `docs/IMPLEMENTATION.md` and the build plan to `docs/PLAN.md`. Claude Code reads them from disk — no pasting walls of text.
2. **Create a `CLAUDE.md`** at the repo root (Claude Code reads it automatically every session). Seed it with: the stack summary, "follow docs/IMPLEMENTATION.md phase by phase," the conventions in §9 of this doc, and this line: *"After implementing each step, explain the new concepts introduced (I'm learning TS/React coming from Python) before moving on."* That last sentence is what turns the build into the learning vehicle.
3. **One step per session-ish.** Don't say "build phase 1." Say "implement step 1.2, then stop and walk me through it." Small prompts keep the diffs reviewable and the explanations digestible.
4. **You run the checkpoints.** Claude Code will claim things work; verify each ✅ yourself. It keeps you honest about understanding, and catches drift early.
5. **Commit per step** (`git commit` after each ✅ passes). If a step goes sideways, `git checkout .` and re-prompt beats untangling.

---

## 1. Prerequisites (on the home server / dev machine)

| Tool | Version | Install note |
|---|---|---|
| Node.js | 22 LTS | via `fnm` or `nvm` (version manager, like pyenv) |
| pnpm | 9+ | `corepack enable && corepack prepare pnpm@latest --activate` (corepack ships with Node) |
| Docker + Compose | current | you already have this |
| Git | current | you already have this |

Dev-loop decision worth understanding: during development only **Postgres runs in Docker**; the API and web dev servers run directly on your machine (instant hot-reload, no rebuild cycle). The full three-container Compose stack is for "deployed" mode on the homelab (§8).

---

## 2. Phase 0 — Skeleton

### Step 0.1 — Monorepo scaffold
```bash
mkdir jobber && cd jobber && git init
pnpm init
```
Create `pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```
Create `tsconfig.base.json` at the root — the shared compiler settings every package extends. The non-negotiable line is `"strict": true` (TS's whole value evaporates without it). Also: `"target": "ES2022"`, `"moduleResolution"` per-app (the web and api need different settings; let each app's own `tsconfig.json` extend the base and override).

Root `package.json` gets convenience scripts: `"dev": "pnpm --parallel --filter './apps/*' dev"`, `"typecheck": "pnpm -r typecheck"`.

**Libraries (root, dev):** `typescript`, `@biomejs/biome` (linter+formatter in one — modern replacement for ESLint+Prettier, one config file, very fast; run `pnpm biome init`).

**✅ Checkpoint:** `pnpm -v` works, repo has workspace file, first commit made.

### Step 0.2 — `packages/shared` (the type contract)
```bash
mkdir -p packages/shared/src
cd packages/shared && pnpm init
pnpm add zod
```
`package.json` trick that makes the monorepo painless: point the entry at the *TypeScript source* —
```json
{ "name": "@jobber/shared", "main": "./src/index.ts", "types": "./src/index.ts" }
```
Both Vite (web) and tsx (api dev runner) happily consume raw TS from workspace packages, so `shared` never needs its own build step in dev. (The api's *production* bundler inlines it — step 8.1.)

First contents of `src/index.ts`: the two founding schemas —
```ts
import { z } from "zod";

export const JobPostingSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  externalId: z.string(),
  title: z.string(),
  location: z.string().nullable(),
  remote: z.boolean().nullable(),
  compMin: z.number().int().nullable(),
  compMax: z.number().int().nullable(),
  url: z.string().url(),
  status: z.enum(["open", "closed"]),
  firstSeenAt: z.coerce.date(),
});
export type JobPosting = z.infer<typeof JobPostingSchema>;   // ← type derived from schema, defined once
```
This `schema → z.infer` pattern is the spine of the codebase: every entity gets a Zod schema here, and both apps import the schema (runtime validation) and the type (compile-time checking) from the same line.

**✅ Checkpoint:** `pnpm --filter @jobber/shared exec tsc --noEmit` passes.

### Step 0.3 — Postgres via Docker
Root `docker-compose.yml`, dev flavor:
```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: jobber
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: jobber
    ports: ["5432:5432"]
    volumes: [dbdata:/var/lib/postgresql/data]
volumes:
  dbdata:
```
`.env` at root (add to `.gitignore` immediately; commit a `.env.example` with blank values instead): `DB_PASSWORD=...`, `DATABASE_URL=postgres://jobber:...@localhost:5432/jobber`.

**✅ Checkpoint:** `docker compose up -d db` then `docker compose exec db psql -U jobber -c "select 1"` returns a row.

### Step 0.4 — `apps/api`: Fastify hello
```bash
mkdir -p apps/api/src && cd apps/api && pnpm init
pnpm add fastify zod fastify-type-provider-zod drizzle-orm postgres
pnpm add -D tsx drizzle-kit @types/node
pnpm add @jobber/shared --workspace
```
What each does: **fastify** the server; **fastify-type-provider-zod** lets routes declare Zod schemas and get automatic request validation + typed handlers (this is the Pydantic moment); **drizzle-orm** the ORM; **postgres** (aka postgres.js) the raw DB driver Drizzle sits on; **tsx** runs TS directly with watch mode (dev only — think `uvicorn --reload`); **drizzle-kit** the migration CLI.

`src/server.ts` skeleton:
```ts
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

app.get("/api/health", async () => ({ ok: true, ts: new Date().toISOString() }));

app.listen({ port: 3001, host: "0.0.0.0" });
```
`package.json` scripts: `"dev": "tsx watch src/server.ts"`, `"typecheck": "tsc --noEmit"`.

Structure note for later steps — the api organizes by **module, not layer**:
```
apps/api/src/
├── server.ts          # bootstrap only
├── db/                # drizzle schema + client (step 1.1)
├── modules/
│   ├── companies/     # routes.ts + service.ts per module
│   ├── jobs/
│   ├── poller/
│   ├── scoring/
│   └── tracker/
└── lib/               # notify.ts, config.ts, small shared helpers
```
Each module exports a Fastify *plugin* (a function receiving `app` and registering its routes) — Fastify's unit of composition; `server.ts` just registers plugins.

**✅ Checkpoint:** `pnpm --filter api dev` then `curl http://localhost:3001/api/health` → `{"ok":true,...}`.

### Step 0.5 — `apps/web`: React hello
```bash
cd apps
pnpm create vite web --template react-ts
cd web
pnpm add react-router-dom @tanstack/react-query
pnpm add tailwindcss @tailwindcss/vite        # Tailwind v4: config lives in CSS, no tailwind.config.js needed
pnpm add @jobber/shared --workspace
pnpm dlx shadcn@latest init                    # answer prompts; then: pnpm dlx shadcn@latest add button card table badge tabs dialog
```
Note the template gives you **React 19** — current stable; nothing in this plan is version-sensitive there.

Two wiring jobs:

**(a) Dev proxy** in `vite.config.ts` so the browser can call `/api/*` without CORS existing as a concept in this project:
```ts
server: { proxy: { "/api": "http://localhost:3001" } }
```

**(b) Providers** in `src/main.tsx`: wrap `<App/>` in `QueryClientProvider` (TanStack Query) and `BrowserRouter` (React Router).

Then a thin API client, `src/lib/api.ts` — the fetch wrapper that validates responses against the shared schemas:
```ts
export async function apiGet<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return schema.parse(await res.json());   // backend lied about a shape? loud error, not silent bug
}
```
First component: `HealthBadge.tsx` using `useQuery({ queryKey: ["health"], queryFn: ... })` rendering green/red. Trivial, but it exercises the entire loop: React → Query → proxy → Fastify → back, with a shared-schema parse in the middle. That loop is Phase 0's actual deliverable.

**✅ Checkpoint:** `pnpm dev` at root starts both apps; browser at `localhost:5173` shows the green health badge; killing the api flips it red.

---

## 3. Phase 1 — Database, poller, tracker

### Step 1.1 — Drizzle schema + first migration
`apps/api/src/db/schema.ts` — tables in Drizzle's TS DSL. Representative slice:
```ts
import { pgTable, uuid, text, boolean, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const companies = pgTable("companies", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  atsType: text("ats_type", { enum: ["greenhouse", "lever", "ashby", "manual"] }).notNull(),
  atsToken: text("ats_token"),
  fitGroup: integer("fit_group"),          // your Group 1–5
  active: boolean("active").notNull().default(true),
});

export const jobPostings = pgTable("job_postings", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  externalId: text("external_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  url: text("url").notNull(),
  contentHash: text("content_hash").notNull(),
  status: text("status", { enum: ["open", "closed"] }).notNull().default("open"),
  firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  // + location, remote, compMin, compMax, source — per the build plan §3
}, (t) => [uniqueIndex("job_dedupe").on(t.companyId, t.externalId)]);   // ← the idempotency key
```
Add the remaining tables from build plan §3 (`applications`, `applicationEvents`, `fitScores`, `profileVersions`, `resumeVersions`, `aiRuns`) the same way. Then `drizzle.config.ts` (points drizzle-kit at schema + `DATABASE_URL`) and:
```bash
pnpm drizzle-kit generate   # writes SQL migration files into ./drizzle — READ the generated SQL, it's the lesson
pnpm drizzle-kit migrate    # applies them
```
`src/db/client.ts` exports the connected client: `export const db = drizzle(postgres(env.DATABASE_URL), { schema })`.

**✅ Checkpoint:** `psql ... -c "\dt"` lists all tables; the generated SQL in `./drizzle/` reads sensibly to you.

### Step 1.2 — Seed the 50 companies
`apps/api/data/companies.json` — transcribed from `Target_Companies.md` (name, atsType, atsToken, fitGroup). `src/scripts/seed.ts` reads it and inserts with `.onConflictDoNothing()` (re-runnable). Script: `"seed": "tsx src/scripts/seed.ts"`.

**✅ Checkpoint:** `select count(*) from companies` ≈ 50.

### Step 1.3 — ATS clients
`src/modules/poller/` gets one file per platform, each exporting the same signature `fetchJobs(token: string): Promise<RawPosting[]>`:

- **greenhouse.ts** → `GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` — jobs in `.jobs[]`, id in `.id`, HTML description in `.content`.
- **lever.ts** → `GET https://api.lever.co/v0/postings/{token}?mode=json` — array at top level, id in `.id`, description in `.description`/`.lists`.
- **ashby.ts** → `GET https://api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true` — jobs in `.jobs[]`.

Implementation notes: use native `fetch` (built into Node 18+, no axios needed). Define a *lenient* Zod schema per platform — validate the fields you use, `.passthrough()` the rest, so a platform adding fields doesn't break polling. `normalize.ts` maps each platform's shape to the shared `JobPosting` shape minus DB-generated fields; this includes `stripHtml` (description arrives as HTML; use the tiny `string-strip-html` lib or a 5-line regex — LLM scoring wants text) and `contentHash` via `node:crypto`: `createHash("sha256").update(title + description).digest("hex")`.

**✅ Checkpoint:** a scratch script fetches one real board of each type and logs normalized postings. (This is also your token-validation pass from the Overview doc — log which of the 50 tokens 404.)

### Step 1.4 — Poll runner: diff + upsert
`src/modules/poller/run.ts`, the orchestrator — this function is the heart of Phase 1:
```
runPoll():
  runStart = now()
  companies = active companies where atsType != 'manual'
  for each company (concurrency-capped):        # pnpm add p-limit — cap at 5 simultaneous fetches
    raw = fetchJobs(token)   → normalize
    for each posting: db.insert(jobPostings)
        .values(...)
        .onConflictDoUpdate({ target: [companyId, externalId],
                              set: { lastSeenAt: runStart, contentHash, status: "open" } })
    # postings previously open for THIS company but not seen this run:
    update ... set status='closed' where companyId=X and lastSeenAt < runStart and status='open'
  newOnes = postings where firstSeenAt >= runStart
  notify + enqueue for scoring (phase 2)
  insert pollRuns row (started, finished, companies_ok, companies_failed, new_count)  # small ops table, add to schema
```
Per-company try/catch: one dead board must never kill the run. **Important correctness detail:** only close postings for companies whose fetch *succeeded* this run — otherwise one API hiccup marks a whole board closed.

Wire the prefilter here too (`src/modules/poller/prefilter.ts`): a pure function `isCandidate(posting): boolean` — title regex built from the AI-Enablement title cluster in the Overview doc + remote/location rule. Pure function = trivially unit-testable (step 9.2).

**✅ Checkpoint:** run `runPoll()` twice via a `POST /api/admin/poll` route; second run creates zero new rows (idempotency proven); `pollRuns` shows two rows.

### Step 1.5 — Scheduling + ntfy
`pnpm add node-cron` → in a `scheduler.ts` plugin: `cron.schedule("0 8,14 * * *", runPoll, { timezone: "America/New_York" })`.
`src/lib/notify.ts`: `await fetch(env.NTFY_URL, { method: "POST", body: msg, headers: { Title, Priority, Tags } })` — pointed at your existing ntfy topic.

**✅ Checkpoint:** temporarily schedule `* * * * *`, see the poll fire and your phone buzz; restore the real schedule.

### Step 1.6 — Tracker import + CRUD
- `data/applications.json` transcribed from the tracker snapshot doc (38 rows) → `src/scripts/import-applications.ts`. Each import creates the `applications` row plus an `applied` event in `applicationEvents` (and a `rejection` event for ApartmentIQ).
- Routes in `modules/tracker/routes.ts`: `GET /api/applications`, `POST /api/applications` (body validated by shared `ApplicationCreateSchema`), `PATCH /api/applications/:id/status` — the PATCH writes an event row *and* updates the denormalized status column (event log = truth, column = convenience).
- Jobs routes in `modules/jobs/routes.ts`: `GET /api/jobs?status=open&candidate=true&companyId=...` with Zod-validated querystring.

**✅ Checkpoint:** `curl` the three endpoints; 38 applications present with event timelines.

### Step 1.7 — First real UI
Pages (React Router routes): `/jobs`, `/companies`, `/pipeline`.
- **Layout**: sidebar nav (shadcn) + `<Outlet/>` (Router's "render child route here" slot).
- **/jobs**: shadcn `<Table>`, TanStack Query fetching `/api/jobs`, client-side filter toggles (open / candidate-only). Badge for company group.
- **/companies**: table + per-company status from `pollRuns` (polling ok / failing / manual bucket).
- **/pipeline**: columns per status rendering application cards — plain flexbox columns first; drag-and-drop is a later nicety (`@dnd-kit/core` when you want it), clicking a card opens a shadcn `<Dialog>` with the event timeline and a status-change select.

Concepts to have Claude Code explain as it builds: component composition, `useQuery` cache keys, *invalidation* (`queryClient.invalidateQueries` after a mutation — why the pipeline refreshes without a reload), and controlled inputs.

**✅ Checkpoint:** you triage the day's real postings and update a real application's status from the browser — the app is now part of the actual job search. **Phase 1 done.**

---

## 4. Phase 2 — AI layer + fit scorer

### Step 2.1 — `packages/ai` scaffold + provider interface
```bash
mkdir -p packages/ai/src/{providers,prompts} && cd packages/ai && pnpm init
pnpm add zod zod-to-json-schema @anthropic-ai/sdk
pnpm add @jobber/shared --workspace
```
`src/provider.ts`:
```ts
export interface AIProvider {
  complete<T>(req: { prompt: string; schema: z.ZodType<T>; schemaName: string;
                     maxTokens?: number; tier: "small" | "large" }): Promise<AIResult<T>>;
}
export type AIResult<T> = { data: T; inputTokens: number; outputTokens: number;
                            model: string; durationMs: number };
```
Design note: the interface has *one* generic method, not `scoreJob`/`reviewResume` — features live in the api's `modules/scoring` etc. and pass prompt+schema in. That keeps `packages/ai` feature-agnostic (and makes the third provider, which serializes requests to files, trivial). `tier` abstracts model choice: `"small"` for bulk scoring, `"large"` for resume review — mapped to concrete model IDs in config (check the current models page when implementing; don't hardcode names in code).

### Step 2.2 — `ApiProvider` (Mode A) with forced structured output
The reliable pattern for schema-shaped output from the Messages API is **forced tool use**: declare one tool whose `input_schema` is your Zod schema converted via `zod-to-json-schema`, set `tool_choice: { type: "tool", name: schemaName }`, and the model *must* respond with arguments matching the schema — you read them from the `tool_use` content block. (Have Claude Code check the current SDK docs for whether native structured-output/`output_format` has landed as a simpler alternative; if so prefer it.)

Wrap the call with: Zod `safeParse` of the result → on failure, **one retry** with the validation errors appended to the prompt → on second failure, throw (and the caller logs a failed `aiRuns` row). Every success logs to `aiRuns` (feature, provider, model, tokens, estimated cost from a small price table in config, duration).

**✅ Checkpoint:** scratch script scores one hardcoded JD; returns valid JSON matching `FitScoreSchema`; `aiRuns` has the row with sane token counts.

### Step 2.3 — Prompts as versioned files
`packages/ai/prompts/score-job.v1.md` — plain markdown with `{{jd}}`, `{{resume}}`, `{{profile}}`, and an explicit "you are screening for a candidate whose constraints are..." framing. A 10-line `renderPrompt(file, vars)` helper (regex replace; no template library needed). The prompt version string gets stored on each `fitScores` row — when you edit a prompt, bump the file version; old scores stay interpretable.

Content guidance for v1 of the scoring prompt (from the project docs): score against the profile rubric; extract comp if disclosed; flag `credential_gap` when the posting demands CS degree / years-of-ML / live coding; suggest channel if the company is known human-read. Calibrate with anchors ("a 5 means...", "an 8 means...") — without anchors LLM scores cluster at 7.

### Step 2.4 — Scoring pipeline + feedback
`apps/api/src/modules/scoring/`: `scorePosting(id)` assembles JD + active resume text + active profile version → `provider.complete({schema: FitScoreSchema, ...})` → insert `fitScores` row. Poller enqueues candidates post-upsert; "queue" v1 = a `scoringQueue` DB table drained by a `setInterval` worker loop in-process (visible, restart-safe, no Redis). ntfy fires immediately for score ≥ 8 with title/company/score/one-liner.

Feedback: `POST /api/scores/:id/feedback { verdict: "up" | "down", note? }` → column on `fitScores`. This data feeds profile revisions in Phase 3.

**✅ Checkpoint:** morning poll produces scored jobs; an 8+ pings your phone before you've opened the dashboard.

### Step 2.5 — Triage page
`/triage`: score-sorted cards (score badge, match points, gaps, credential flag icon, rationale expander), actions: open URL / mark applied (creates application linked to posting) / dismiss / 👍👎. Add a small "AI spend" stat (sum of `aiRuns.estCost` this month) in the corner — the cost-awareness story, visible daily. **Phase 2 done — this is the portfolio-demo moment; screen-record it.**

---

## 5. Phase 3 — Profile, resume, alternate providers

### Step 3.1 — Ideal Job Profile
Schema: `IdealJobProfileSchema` in shared — `northStar` (prose), `hardFilters` (comp floor, location rule), `criteria[]` ({name, weight 1–5, description}). v1 builder is honest and simple: a form pre-seeded from a one-shot AI call that reads resume + strategy notes + application history and *proposes* a profile; you edit and save → `profileVersions` row. The chat-style interview flow is a later polish. Scorer prompt already consumes `{{profile}}`; a "re-score open candidates against new version" button closes the loop and shows you score diffs.

### Step 3.2 — Resume versions
`pnpm add @fastify/multipart mammoth` (docx→text; if you add PDF support later: `pdf-parse`). Upload route stores file to a `data/resumes/` volume + extracted text to `resumeVersions`. UI: version list, view text, set active. **Review** feature: `provider.complete` with `ResumeReviewSchema` (strengths, weaknesses, per-section suggestions, ats_flags) on the `large` tier. **Tailor-to-posting**: from a high-scoring job → suggestions + drafted outreach note rendered as a side-by-side diff (`react-diff-viewer-continued`, or the `diff` npm package + your own rendering) — output saved as a *draft* attached to the application; you finish it by hand, per house rule.

### Step 3.3 — `CliProvider` (Mode B) and `CoworkProvider` (Mode C)
- **CliProvider**: `node:child_process` `execFile("claude", ["-p", "--output-format", "json"], ...)` piping the prompt via stdin (avoids arg-length limits); parse the JSON envelope's `result` field, then the same safeParse/retry as Mode A. Runs where Claude Code is logged in (the homelab). Config: `AI_PROVIDER=cli`.
- **CoworkProvider**: `complete()` writes `ai-queue/pending/{uuid}.json` ({prompt, jsonSchema, meta}) and returns a pending marker (the scoring worker treats "pending" as done-for-now); `pnpm add chokidar` watcher on `ai-queue/done/` validates+ingests results and deletes processed files. Add `ai-queue/README.md` telling the Cowork session exactly what to do — process every pending file, write results to done/, matching schema. Then a scheduled Cowork task with the repo folder connected handles batches.
- After both work: run the same week of scoring through two providers and screenshot the `aiRuns` cost/latency comparison. That artifact is interview gold.

---

## 6. Phase 4 — More sources, ingestion, analytics (outline level)

- **HN Who is Hiring**: Algolia HN API — search `whoishiring` for the current month's thread, pull top-level comments (`hn.algolia.com/api/v1/items/{threadId}`), LLM-extract structured postings (small tier; it's a parsing task). Monthly cron on the 1st, 10am ET.
- **RSS** (WeWorkRemotely, Remotive): `pnpm add rss-parser`, same normalize→upsert path with `source: "rss"`.
- **Bookmarklet capture**: `POST /api/jobs/capture {url, pageText}` → LLM-parse into a posting. The bookmarklet is ~5 lines of JS wrapped in `javascript:`; needs a static token header since it posts from anywhere on your LAN.
- **IMAP status ingestion** (Yahoo): `pnpm add imapflow mailparser`; poll INBOX since last check, match sender domains against applied companies, LLM-classify (ack/rejection/interview/noise, small tier) → *proposed* events in UI, you confirm. Yahoo needs an app password — verify support before building (open question from the build plan).
- **Analytics page**: `pnpm add recharts`. Queries live in `modules/analytics/queries.ts` as raw SQL via Drizzle's `sql` template — deliberately, because window functions (`count(*) filter (where ...)`,  weekly buckets via `date_trunc`) are your "heavy SQL" practice ground. Charts: conversations/week (the strategy metric), response rate by channel, score distribution, time-to-first-response, monthly AI spend.

### Phase 4b — DuckDB sidecar
`pnpm add @duckdb/node-api` (the current official Node client). Nightly cron: open DuckDB, `ATTACH 'postgres://...' AS pg (TYPE postgres)` (DuckDB's postgres extension reads your live tables directly), `COPY (SELECT ...) TO 'exports/applications.parquet' (FORMAT parquet)` per table, then re-point the analytics queries at the Parquet files through DuckDB and compare. Optional on top: `dbt-duckdb` for real transform models. README writes up the two-engine pattern and where the crossover would actually matter.

---

## 7. Phase 5 — Portfolio polish (outline level)

Demo mode: `SEED_DEMO=true` seed script with fictional companies/postings/scores/applications (LLM-generate the fixture file once, commit it). README: architecture diagram, decisions-log table from the build plan, cost ledger screenshot, honest "what I'd do differently." A 60–90s screen recording of triage→apply→pipeline. Optional short write-up post.

---

## 8. Deployment (homelab, "prod" mode)

### Step 8.1 — Production images
- **api**: bundle with `tsup` (`pnpm add -D tsup`) — one esbuild-powered command that inlines the workspace packages into `dist/server.js`; multi-stage Dockerfile: `node:22-slim` build stage → runtime stage copying `dist/` only. Run migrations on container start (`drizzle-kit migrate && node dist/server.js`).
- **web**: build stage runs `vite build` → `nginx:alpine` stage serves `dist/` with a config that proxies `/api/` to `http://api:3001` (same trick as the dev proxy, so the SPA needs zero environment awareness).
- Compose adds `api` and `web` services (db unchanged), `restart: unless-stopped`, web published on your chosen LAN port. Wire into your existing homelab DNS/reverse-proxy for `jobber.local`. **No auth in v1 = never expose beyond LAN; Tailscale if you want it on your phone off-network.**

**✅ Checkpoint:** `docker compose up -d --build` on the server; dashboard loads from another machine on the LAN; cron fires next morning (check `pollRuns`).

---

## 9. Conventions & guardrails (goes into CLAUDE.md)

1. **Strict TS everywhere; `any` is a code smell** — have Claude Code justify any escape hatch.
2. **Biome** for lint+format; `pnpm biome check --write .` clean before each commit.
3. **Tests where they pay rent** (`pnpm add -D vitest`, runs TS natively): the normalizers (fixture JSON per ATS platform → expected normalized output), `prefilter`, prompt rendering, and the upsert/close logic (against a throwaway DB or in-memory fake). UI tests: skip in v1.
4. **Every external input crosses a Zod boundary**: ATS responses, API request bodies, LLM outputs, queue files. Nothing untyped gets past the edge.
5. **Secrets only in `.env`** (gitignored, `.env.example` committed). The Anthropic key never appears in frontend code — the browser talks only to your API.
6. **Conventional-ish commits per step** ("phase1: poller diff+upsert (step 1.4)") so the history reads as the build log — it becomes portfolio evidence too.
7. **Claude Code explains before moving on** — each step's new concepts, until you could re-implement them. (Interview-prep rule from the Overview doc applies to this project doubly.)

---

## 10. Library quick-reference

| Library | Where | What it is |
|---|---|---|
| fastify | api | web framework (the FastAPI analog) |
| fastify-type-provider-zod | api | Zod-powered request/response validation on routes |
| drizzle-orm + drizzle-kit | api | typed SQL/ORM + migration CLI |
| postgres (postgres.js) | api | Postgres driver under Drizzle |
| zod (+ zod-to-json-schema) | everywhere | schema/validation spine; converts to JSON Schema for LLM tools |
| tsx | api dev | run/watch TS directly (uvicorn --reload analog) |
| tsup | api build | bundler for the production image |
| node-cron | api | in-process cron scheduling |
| p-limit | api | concurrency cap for polite polling |
| @anthropic-ai/sdk | packages/ai | Claude API client (Mode A) |
| chokidar | packages/ai | file watcher (Mode C queue) |
| mammoth / pdf-parse | api | docx / pdf → text extraction |
| imapflow + mailparser | api (P4) | IMAP client + email parsing |
| rss-parser | api (P4) | RSS ingestion |
| @duckdb/node-api | api (P4b) | DuckDB OLAP engine |
| react + react-router-dom | web | UI + client-side routing |
| @tanstack/react-query | web | server-state fetching/caching |
| tailwindcss + shadcn/ui | web | styling + component kit |
| recharts | web (P4) | charts |
| react-diff-viewer-continued | web (P3) | resume diff view |
| vite | web | dev server + bundler |
| biome, vitest | dev | lint/format, tests |

---

*Standing instruction to Claude Code: where this plan names a library, install the current stable major and consult its official docs if the API differs from the sketches here — the sketches show intent, the docs win on syntax.*
