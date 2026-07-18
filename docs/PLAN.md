# Jobber — Self-Hosted Job Search Platform: Build Plan

**Working name:** Jobber (rename freely). **Owner:** Mike Brown. **Drafted:** July 17, 2026.

**What it is:** A web dashboard running on your home network that pulls job postings from ATS platforms, scores them against an AI-built "ideal job" profile, reviews and tailors your resume, tracks your application pipeline, and notifies you when something worth your time shows up. It replaces the current pieced-together system (xlsx tracker + manual inbox scans + Claude sessions) with one product — and doubles as your flagship portfolio piece for AI Enablement roles.

**Why this is a strong portfolio play:** the roles you're targeting recur on one phrase — *"delivery role, not a research role."* This project is literally that: an LLM integrated into a real workflow with structured outputs, cost awareness, and a UI a non-engineer could use. In an interview you can demo it live, walk through why each architectural choice was made, and point at the ranked queue it produced — the job you're interviewing for may have been surfaced by it.

---

## 1. The big picture

```
┌─────────────────────────── Your home server (Docker Compose) ───────────────────────────┐
│                                                                                         │
│  ┌──────────────┐     REST (JSON)      ┌──────────────────────┐      ┌───────────────┐  │
│  │  React SPA   │ ◄──────────────────► │   Fastify API (TS)   │ ◄──► │  PostgreSQL   │  │
│  │  (Vite build)│                      │                      │      │  (+ pgvector  │  │
│  └──────────────┘                      │  ├── REST routes     │      │    later)     │  │
│        ▲                               │  ├── Scheduler       │      └───────────────┘  │
│        │ browser on your LAN           │  │   (node-cron)     │                         │
│   http://jobber.local:8080             │  │    ├─ Poller ─────┼──► Greenhouse/Lever/    │
│                                        │  │    └─ Scorer      │    Ashby/HN/RSS         │
│                                        │  └── AI Provider     │                         │
│                                        │      abstraction ────┼──► Claude API           │
│                                        └──────────┬───────────┘    or `claude -p` CLI   │
│                                                   │                or Cowork file queue │
│                                                   └──► ntfy (your existing notifier)    │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

Reading that diagram left to right:

- **React SPA (single-page app):** everything you see. Built once into static files, served on your LAN. The browser talks to the backend only through a JSON API — no page reloads.
- **Fastify API:** the backend brain. Serves the JSON API, runs scheduled background jobs (polling, scoring) inside the same process for v1, and owns all business logic.
- **PostgreSQL:** the single source of truth. Jobs, companies, applications, scores, your profile, AI run logs — all here.
- **AI Provider abstraction:** the interesting part. Every AI feature (scoring, resume review, profile building) goes through one interface with swappable backends — Claude API, your Claude subscription via the CLI, or a file-based handoff to Cowork. Section 4 explains this in depth.
- **ntfy:** you already run this. The poller and scorer push "3 new jobs, one scored 9/10" to your phone.

**A note on "why not microservices":** one API container + one DB is deliberately boring. For a single-user LAN app, splitting into services adds failure modes without adding value. The portfolio signal comes from clean *internal* boundaries (modules, the provider abstraction), not from container count. Being able to say that in an interview is itself a senior-sounding judgment call.

---

## 2. Tech stack, choice by choice

### TypeScript everywhere
TypeScript is JavaScript plus a type system checked at build time. Coming from Python, think "type hints, but actually enforced, and the whole ecosystem uses them." Choosing it for both frontend and backend means: one language to learn instead of two, one toolchain, and — the killer feature — **shared types**. You define what a `JobPosting` looks like once, in a shared package, and both the API and the React app import it. Change the shape, and the compiler flags every place that breaks on both sides. This is the thing Flask+JS projects can't do, and it's a big part of why full-stack TS dominates startup stacks right now.

### Frontend: React 18 + Vite
- **Vite** is the build tool/dev server (the modern replacement for create-react-app). Instant startup, hot reload, one command to build static files.
- **React** you already chose. The mental model in one paragraph: the UI is a function of state. You write components (functions returning JSX, an HTML-like syntax), state lives in hooks (`useState`), and when state changes React re-renders what depends on it. You never manually manipulate the DOM the way you would with jQuery or vanilla JS.
- **TanStack Query** for server data. This library manages fetching/caching/refetching from your API and is the single biggest quality-of-life win in modern React — without it you hand-roll loading states, error states, and cache invalidation for every endpoint. With it, `useQuery({queryKey: ['jobs'], queryFn: fetchJobs})` gives you all three.
- **Tailwind CSS** for styling (utility classes in markup; fast to iterate, no naming-CSS-classes ceremony), plus **shadcn/ui** for prebuilt accessible components (tables, dialogs, tabs) you copy into your repo and own.
- **React Router** for pages (it's a SPA, so "pages" are client-side routes).

### Backend: Fastify (over Express and NestJS)
Fastify is to Node what FastAPI is to Python — the analogy is almost exact, which is why it's the right bridge for you:

| FastAPI concept | Fastify equivalent |
|---|---|
| Pydantic request/response models | JSON Schema / Zod validation per route |
| Auto docs from types | `@fastify/swagger` |
| Dependency injection via params | Plugins + decorators |
| uvicorn | Built-in server |

Why not the alternatives: **Express** is the old default — minimal, callback-flavored, no built-in validation; you'd spend your time wiring middleware that Fastify ships with. **NestJS** is the "enterprise" framework (Angular-style decorators, heavy DI container) — impressive-looking but it hides the Node fundamentals you're trying to learn. Fastify keeps you close to the metal with modern ergonomics.

### Database: Postgres 16 + Drizzle ORM
Postgres you chose. **Drizzle** is the ORM (the layer that maps TS objects to SQL). Recommending it over Prisma because Drizzle is a thin, typed wrapper where you can always see the SQL it generates — you'll actually learn Postgres instead of learning an abstraction over it — and it's the current momentum choice in the TS world. It also handles migrations (versioned schema-change files), which is a concept worth learning properly: your DB schema evolves through checked-in migration files, never by hand-editing tables.

### Validation and shared contracts: Zod
Zod is a TS library where you define a schema once (`z.object({score: z.number().min(0).max(10), ...})`) and get three things from it: runtime validation (reject bad API requests), the TS type (inferred automatically), and — crucially for us — **a JSON Schema you can hand to Claude** to force its output shape. One definition powers the API contract, the frontend types, and the LLM structured output. This is the elegant trick at the center of the codebase.

### Scheduling: node-cron in-process (v1)
A tiny library that runs functions on a cron schedule inside the API process ("poll ATS boards at 8am and 2pm"). The "real" production answer is a job queue (BullMQ + Redis) with retries and a worker process — that's deliberately deferred. For a single user polling ~60 endpoints twice a day, in-process cron is correct, and "I started with cron and documented the upgrade path to a queue" is a better engineering story than premature Redis.

### Deployment: Docker Compose on the homelab
Three services: `db` (postgres image + volume), `api` (multi-stage Dockerfile: build TS → run JS), `web` (nginx serving the Vite build, proxying `/api` to the api container — this also neatly sidesteps CORS). You already run Docker, so this slots into your existing setup; add it to whatever reverse proxy/DNS you use so it's `jobber.local` or similar on your LAN. `.env` file for secrets (API key, ntfy topic), never committed.

### Monorepo: pnpm workspaces
```
jobber/
├── apps/
│   ├── web/          # React SPA (Vite)
│   └── api/          # Fastify server
├── packages/
│   ├── shared/       # Zod schemas + TS types used by both apps
│   └── ai/           # AI provider abstraction (see §4)
├── docker-compose.yml
├── pnpm-workspace.yaml
└── README.md         # the portfolio-facing document
```
pnpm is the package manager (faster npm with proper workspace support). A workspace means `apps/web` can do `import { JobPostingSchema } from '@jobber/shared'` and it Just Works, locally and in Docker builds.

---

## 3. Data model

The schema in plain English (Drizzle tables; names are suggestions):

- **companies** — id, name, ats_type (`greenhouse` | `lever` | `ashby` | `manual`), ats_token, group (your Group 1–5 fit tiers), notes, active. Seeded from `Target_Companies.md` (~50 rows + tokens already collected).
- **job_postings** — id, company_id, external_id (the ATS's own ID — the dedupe key), title, location, remote flag, comp_min/comp_max (parsed when disclosed), description (full text), url, source (`poller` | `manual` | `hn` | `rss`), first_seen_at, last_seen_at, status (`open` | `closed` — poller marks closed when a posting disappears), content_hash (detect edited postings).
- **fit_scores** — id, job_posting_id, profile_version, score (0–10), match_points (json array), gaps (json array), credential_gap_flag (boolean — "will this screen me out on ML tenure / live coding?"), rationale, model_used, created_at. One row per scoring run, so re-scoring after a profile update keeps history.
- **applications** — id, job_posting_id (nullable — you'll apply to things the poller never saw), company snapshot fields, channel (`ats` | `careers_email` | `hn` | `wellfound` | `referral`), applied_at, status (`applied` | `screen` | `interview` | `offer` | `rejected` | `ghosted`), resume_version_id, notes. Your existing 38 applications get imported here on day one.
- **application_events** — id, application_id, type (`applied` | `auto_ack` | `rejection` | `screen_invite` | `note`), occurred_at, detail. An event log rather than just a status column, so the analytics ("conversations per week", time-to-response by channel) fall out of a query instead of a spreadsheet.
- **profile** — versioned rows of your Ideal Job Profile (§5.3): prose + structured JSON (weighted criteria). The scorer always references a specific profile_version — that's what makes score history meaningful.
- **resume_versions** — id, label, file path, extracted_text, created_at. Base resume plus tailored variants, so every application records exactly which resume went out.
- **ai_runs** — id, feature (`score` | `resume_review` | `profile`), provider, model, input_tokens, output_tokens, est_cost, duration_ms, created_at. A cost/audit ledger. Small table, outsized interview value: "here's my dashboard's LLM spend chart" is exactly the cost-awareness AI Enablement roles probe for.

Concepts you'll meet here for the first time and why they're shaped this way: **external_id + content_hash** make polling idempotent (running it twice can't create duplicates); the **event log** pattern (append events, derive current status) beats mutating a status field because you never lose history; **versioning** the profile and resume turns "the AI's opinion changed" from a mystery into a diff.

---

## 4. The AI layer — including your Cowork question

You asked: *"is there any way I could run that stuff in Claude Cowork and just hook the codebase folder up to it? it wouldn't run constantly."*

Yes — and rather than pick one answer, the architecture makes the AI backend **pluggable**, because the three realistic options have different cost/automation tradeoffs and you'll likely want to switch between them. I verified the details against Anthropic's current docs; here's the honest picture.

### The three provider modes

**Mode A — Claude API (`provider: "api"`).** The backend calls the Messages API directly with an API key from platform.claude.com. Pay-per-token, separate from your claude.ai subscription. Fully automated: a job arrives at 8am, it's scored by 8:01. Rough cost at your scale: scoring one job ≈ ~2.5k input + ~500 output tokens; on the cheap model tier that's well under a cent per job, so 30 jobs/day lands around **$3–6/month** (resume reviews on a stronger model add pennies each). For the portfolio, this is also the mode reviewers expect to see — structured outputs against a JSON schema is the canonical pattern.

**Mode B — Claude subscription via CLI (`provider: "cli"`).** Claude Code's headless mode (`claude -p "prompt" --output-format json`) works when logged in with your claude.ai Pro/Max account — no API key, no per-token billing. Your Node backend shells out to it as a child process. The catches, from the docs: usage draws from your subscription's rolling 5-hour + weekly limits, *shared with your chat and Cowork usage*, so heavy batches compete with your actual Claude use; it's designed for interactive/dev use, so treat it as a personal-scale convenience, not a production pattern; and the Agent SDK proper requires an API key (subscription auth is CLI-login only). At 20–40 scoring calls a day this is realistically fine and costs you $0 incremental. It only runs where Claude Code is installed and logged in — i.e., your home server, which is exactly where the app lives anyway.

**Mode C — Cowork file queue (`provider: "cowork"`), your idea.** The backend can't *push* work to Cowork, but it can leave work where Cowork will find it. Flow: unscored jobs get written to `ai-queue/pending/*.json` in the repo folder (each file = one job + your resume text + the profile + the expected output schema). You open Cowork with that folder connected — or a scheduled Cowork task does it on weekday mornings — and Claude processes everything in `pending/`, writing results to `ai-queue/done/*.json`. The backend watches `done/`, validates each file against the Zod schema, ingests, archives. Zero incremental cost (subscription), and batch-asynchronous by design — which matches how you'd actually triage anyway ("morning coffee, review the overnight 8+s"). The tradeoff is latency and a human (or scheduled task) in the loop.

### Why this becomes the portfolio centerpiece

All three hide behind one interface in `packages/ai`:

```ts
interface AIProvider {
  scoreJob(input: ScoreJobInput): Promise<FitScore>;        // may resolve later (queue mode)
  reviewResume(input: ReviewInput): Promise<ResumeReview>;
  buildProfile(input: ProfileInput): Promise<IdealJobProfile>;
}
```

Every call: renders a versioned prompt template, demands JSON matching the Zod-derived schema, validates the response (retry once on invalid), logs tokens/cost to `ai_runs`. Which mode runs is one line of config. Start with **Mode A** while building (simplest to debug, and $5/month is cheap tuition), add **B or C** once the pipeline works. In interviews this is a gift of a talking point: *"I abstracted the model provider so the same pipeline runs against metered API, my flat-rate subscription, or an async human-in-the-loop queue — here's the cost ledger comparing them."* That's a genuinely uncommon and senior design story.

### Prompt design principles (applies to every feature)

Prompts live in the repo as versioned template files, not inline strings — you'll iterate on them constantly and want diffs. Every scoring prompt gets: the JD, your resume text, the current Ideal Job Profile, and the output schema. Temperature low. And one rule inherited from your channel strategy: **AI drafts, you finish** — anything that leaves the house (outreach notes, tailored bullets) is generated as a draft for human rewrite, never auto-sent.

---

## 5. Feature specifications

### 5.1 Job poller
Hits the three pollable ATS APIs for every active company on a schedule (2× daily):
- Greenhouse: `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`
- Lever: `api.lever.co/v0/postings/{token}?mode=json`
- Ashby: `api.ashbyhq.com/posting-api/job-board/{token}`

These are public, documented JSON endpoints — no scraping, no ToS gray zone. Logic per run: fetch → normalize into the common `job_posting` shape → upsert by (company, external_id) → new rows trigger a title/keyword prefilter (your AI-Enablement title cluster + remote + comp floor) → matches enqueue for scoring → postings that vanished get marked `closed`. Failures are logged per-company, never fatal to the run. Companies on Eightfold/Workable/etc. (Symetra, Coursedog) live in a **manual-check bucket** the dashboard surfaces weekly — honest scope control beats brittle scrapers.

**Additional sources, phased in later:** HN "Who is Hiring" via the Algolia API (monthly thread, parse top-level comments, LLM-extract structured fields — a fun hard-parsing showcase); WeWorkRemotely/Remotive RSS; and a **bookmarklet** that POSTs the current page's URL + text to `/api/jobs/capture` so any posting you find in the wild enters the same pipeline (LLM parses the raw text into the schema). Deliberately excluded: LinkedIn/Indeed scraping (ToS violations, fragile — and saying *why* you excluded them is a portfolio point, not a gap).

### 5.2 Fit scorer
The centerpiece. For each new posting: JD + resume + Ideal Job Profile → structured verdict: `score` 0–10, top-3 `match_points`, `gaps`, `credential_gap_flag` ("does this screen on ML tenure / CS degree / live coding?" — your known filter), one-paragraph `rationale`, suggested `channel` if the company has a human-read path. Scores ≥8 push to ntfy immediately; the rest wait in the triage queue. A thumbs-up/down on each score is stored and fed back into the next profile revision (§5.3) — a real, simple feedback loop, no fine-tuning theater.

### 5.3 Ideal Job Profile ("formulate the perfect job for me")
Instead of scoring against the resume alone, the app maintains an explicit, versioned definition of what you're looking for — and builds it with you. An interview-style flow in the UI: Claude reads your resume, the strategy notes (the Overview doc's constraints: $85–100K+ floor, remote/hybrid-Saratoga, delivery-not-research, screens-on-business-judgment), and your application history with outcomes, then asks you a handful of sharp questions and emits two artifacts: a prose "north star" statement and a **weighted rubric** (JSON: criteria, weights, hard filters vs. soft preferences) that becomes the scorer's grading key. When outcomes accumulate — rejections, screens, your thumbs on scores — you rerun the flow and it proposes a revised version, showing the diff. This turns "what job do I actually want?" from vibes into a versioned, evolving document, and it's the feature that makes the whole app more than a job board.

### 5.4 Resume review & tailoring
Upload/keep resume versions (docx parsed to text via mammoth, pdf via pdf-parse). Two modes: **general review** (structured critique: strengths, weaknesses, section-by-section suggestions, ATS-parseability flags) and **tailor to posting** — from any high-scoring job, one click gets reordered/re-emphasized bullet suggestions and a draft outreach note, presented as a side-by-side diff against the base resume. Output is always a draft you edit (per the AI-drafts-you-finish rule); the version that ships is saved and linked to the application record.

### 5.5 Application tracker
The xlsx, upgraded: kanban pipeline (Applied → Screen → Interview → Offer, plus Rejected/Ghosted), event timeline per application, channel tagging, linkage to posting + score + resume version. Day-one import script for the 38 existing applications from the project tracker doc. Later phase: **IMAP ingestion** from the Yahoo inbox — poll for messages matching applied-to companies, LLM-classify (ack / rejection / interview invite / noise), and propose status updates you confirm in the UI. That kills the most tedious manual chore in the current system.

### 5.6 Dashboard UI (the React app)
Five pages, in build order:

1. **Triage** — the daily driver. New scored postings sorted by score; each card: title, company, comp, score badge, match points, gaps, credential flag; actions: open posting / mark applied / dismiss / thumbs on the score.
2. **Pipeline** — the kanban + application detail views with event timelines.
3. **Companies** — the 50-company list, ATS status (polling ok / failing / manual bucket), per-company posting history.
4. **Analytics** — the numbers your strategy doc says to steer by: **conversations per week** (the metric), response rate by channel, apps per week, score distribution, time-to-first-response, LLM cost from `ai_runs`. (Read the dataviz skill before building charts.)
5. **Profile & Resume** — current Ideal Job Profile with version history/diffs, resume versions, the interview-flow to revise the profile.

### 5.7 Notifications
Reuse the existing ntfy channel: instant push for 8+ scores; a daily digest ("5 new, 2 worth a look, 1 flagged 9.1 — Symetra reposted"); weekly analytics summary. One tiny module, big daily-use payoff.

---

## 6. Phased roadmap (lean core first, as chosen)

Each phase ships something you actually use for the live job search. Estimates assume evenings/weekends alongside learning the stack.

**Phase 0 — Skeleton (1 weekend).** Monorepo scaffold, Docker Compose with Postgres, Fastify serving `GET /api/health`, React app rendering data fetched from it, Drizzle configured with the first migration (`companies`, `job_postings`). Success = one end-to-end request on your LAN. Small, but it's where 80% of the "new stack" learning friction lives — budget patience here, not in later phases.

**Phase 1 — Poller + tracker (1–2 weekends).** Seed the 50 companies, build the three ATS clients + normalizer + upsert, node-cron schedule, ntfy on new matches, import the 38 applications, minimal UI: jobs list + companies page + basic pipeline board. **The app is now useful daily, before any AI is wired in.**

**Phase 2 — AI layer + fit scorer (1–2 weekends).** `packages/ai` provider abstraction with Mode A (API), scoring prompt v1, `fit_scores` + `ai_runs` tables, Triage page with score cards and thumbs, instant ntfy for 8+s. This is the moment it becomes a portfolio piece.

**Phase 3 — Profile + resume (2 weekends).** Ideal Job Profile builder flow + versioning, scorer switched to profile-based rubric, resume upload/parse/review, tailor-to-posting with diff view. Add Mode B (CLI) or Mode C (Cowork queue) now that prompts are stable — and capture the cost comparison.

**Phase 4 — More sources + analytics (ongoing).** HN Who is Hiring ingestion, RSS, bookmarklet capture, manual-check bucket UX, Analytics page, IMAP status ingestion.

**Phase 4b — DuckDB analytics sidecar (optional, ~1 weekend).** A miniature data-warehouse pipeline mirroring the industry OLTP→OLAP pattern: a scheduled export job dumps the Postgres tables to Parquet files (columnar format), and the Analytics page's heavy queries run through **DuckDB** (in-process columnar OLAP engine — conceptually a mini-Snowflake/Databricks) instead of Postgres. Optionally layer **dbt** (with the DuckDB adapter) on top to define the transform models the way analytics engineers do. Zero new infrastructure — DuckDB is a library, not a server. At Jobber's data volume this is admittedly unnecessary, and that's the point of documenting it honestly: the README says "Postgres handles this scale fine; the sidecar exists to demonstrate the two-engine pattern and where the crossover happens." Resume/interview payoff: hands-on columnar storage, Parquet, ELT, and warehouse vocabulary (the Snowflake/Databricks/BigQuery cluster that recurs in listings) backed by a working pipeline you built.

**Phase 5 — Portfolio polish (1 weekend, do not skip).** **Demo mode**: a seed script with fictional companies/jobs/scores so you can demo or screen-record without exposing your real search. README with the architecture diagram, an honest "decisions & tradeoffs" section (cron vs. queue, no-LinkedIn-scraping, provider abstraction, cost ledger), screenshots/GIF. Optionally a short write-up post. This phase is cheap and is most of the portfolio value — schedule it, don't leave it aspirational.

---

## 7. Learning path for the new stack

Order matters — each layer motivates the next, and the project itself is the exercise track:

1. **TypeScript first, in isolation (a few evenings).** The official handbook's "TS for JS Programmers" plus poking at types in a scratch file. From Python you already know the concepts (it's type hints + generics with real enforcement); the syntax is the only hurdle.
2. **Node/Fastify next (Phase 0–1).** Lean on the FastAPI analogy table above. New-to-you concepts worth reading about deliberately: the event loop and `async/await` everywhere (Node is single-threaded; all I/O is async — closer to asyncio than to Flask), `package.json` scripts, and ESM imports.
3. **React last (from Phase 1's UI onward).** Do the official react.dev "Learn React" track, then build the jobs list. Rule of thumb for sanity: server data lives in TanStack Query, page state lives in `useState`, and reach for nothing fancier until it hurts.
4. **Drizzle/Postgres as you go.** Write the first migration by hand-reading the docs; after that it's repetition.

Also honestly: you build with Claude Code daily — use it here too, but for a learning project, have it *explain* generated code until you could re-write it. The interview risk isn't "AI helped build it," it's not being able to defend a line of it. (Your Overview doc's interview-prep note says exactly this about the ADK projects.)

---

## 8. Decisions log (the "why" ledger — keep updating it)

| Decision | Choice | Why | Revisit when |
|---|---|---|---|
| Backend | Fastify + TS | FastAPI-like ergonomics; shared types with React; market signal | Never for this project |
| ORM | Drizzle | SQL-transparent, typed, momentum | If migrations chafe → Prisma |
| DB | Postgres (Docker) | Concurrency, FTS, pgvector option, portfolio-standard | — |
| Scheduling | node-cron in-process | Single user, ~60 endpoints; queue is overkill | If jobs need retries/fan-out → BullMQ |
| AI default | Mode A (API) | Debuggable, automated, ~$5/mo | Add B/C in Phase 3 for cost story |
| Job sources | Official ATS JSON + HN + RSS only | No ToS gray zones; scrapers are treadmills | Bookmarklet covers the gap |
| Auth | None beyond LAN (v1) | Home network only | Expose beyond LAN → add real auth first |
| Semantic search | Deferred | Keyword prefilter + LLM scoring covers v1 | pgvector when dedupe/similar-jobs itch |
| Analytics engine | Postgres now, DuckDB sidecar in 4b | Right-sized for the data; sidecar demonstrates OLTP→OLAP pattern for resume | — |

### Skills-coverage map (project ⟷ job-listing keywords)

An explicit goal: the build should touch as many skills recurring in target listings as possible, each backed by a real working artifact rather than a bullet point. Current coverage: **TypeScript / React / Node** (the whole app), **REST API design** (Fastify + OpenAPI via swagger), **SQL / Postgres** (schema design, migrations, window-function analytics queries), **Snowflake-adjacent OLAP** (DuckDB + Parquet + ELT sidecar, dbt optional), **LLM integration / prompt engineering** (structured outputs, versioned prompts, provider abstraction, cost ledger), **Docker / DevOps** (Compose, multi-stage builds, homelab deploy), **data pipelines** (poller → normalize → dedupe → score), **product analytics** (channel funnel metrics), **BI concepts** (the Analytics page is a hand-built Tableau-style dashboard — see README framing). When a new skill keeps appearing in listings, check whether a small honest slice of it fits here before bolting it on: one real weekend artifact beats three aspirational ones.

---

## 9. Open questions for future sessions

- Name the thing (repo + README need it before Phase 5).
- Comp parsing: postings disclose pay inconsistently — regex first, LLM-extract fallback? (Cheap experiment in Phase 2.)
- Should the profile rubric hard-filter (never show sub-floor comp) or soft-penalize? Current lean: hard-filter only on your two true constraints (comp floor, location), soft everything else.
- IMAP against Yahoo specifically — verify app-password support before promising Phase 4's email ingestion.
- Whether to eventually expose it off-LAN (Tailscale would be the sane path, and is itself a nice homelab talking point).
