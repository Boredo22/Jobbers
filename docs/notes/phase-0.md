# Phase 0 — Skeleton: study notes

> What we built, why it's shaped this way, the gotchas we hit, and the interview
> questions this phase prepares you to answer. Written for interview-defense: you
> should be able to re-implement every piece and justify every choice.

**Deliverable:** one end-to-end request on your LAN — the browser renders a health
badge whose color comes from a live call through a proxy to the Fastify API,
validated by a schema shared between both apps.

```
Browser (React :5173)
  → TanStack Query (useQuery)
    → Vite dev proxy (/api → :3001)
      → Fastify (GET /api/health)
        → back as JSON
      → HealthSchema.parse()   ← the shared-schema validation boundary
    → badge renders green / red
```

Postgres (Docker) is stood up but has no tables yet — those arrive in Phase 1.

---

## The five steps at a glance

| Step | What | Key artifact |
|---|---|---|
| 0.1 | Monorepo scaffold | `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json` |
| 0.2 | Shared type contract | `packages/shared` — Zod schemas + `z.infer` types |
| 0.3 | Postgres via Docker | `docker-compose.yml`, `.env` / `.env.example` |
| 0.4 | Fastify API | `apps/api/src/server.ts` — `GET /api/health` |
| 0.5 | React app + full loop | `apps/web` — Vite, TanStack Query, `HealthBadge` |

---

## Core ideas to remember

### 1. The `schema → z.infer<typeof …>` pattern (the spine of the codebase)

TypeScript has **two separate worlds**: the *value* world (runtime code) and the
*type* world (erased before the program runs). A Zod schema is a **value** you can
call `.parse()` on. To get a static **type** out of it:

```ts
export const JobPostingSchema = z.object({ /* … */ });  // value — runtime validator
export type JobPosting = z.infer<typeof JobPostingSchema>; // type — derived, never drifts
```

- `typeof JobPostingSchema` (in type position) = "the type TypeScript inferred for
  this value" — a gnarly internal `ZodObject<…>`.
- `z.infer<…>` translates that into the clean object type `{ id: string; … }`.

**Why it matters:** define the shape once. The validator and the type can never
disagree because one is generated from the other. Add a field → the type updates →
the compiler flags every place that must now handle it. (Same instinct as a
Pydantic/SQLAlchemy models file being the single source of truth — TS just splits
the "validate" half and the "type" half into two names, glued by `z.infer`.)

### 2. Shared types across the wire (the thing Flask + JS can't do)

`packages/shared` exports schemas that **both** the API and the web app import.
The `HealthSchema` is defined once and used on both sides of the network boundary.
Change it, and both the server and the client fail to compile in the same commit.
This is the single biggest reason to run TypeScript end-to-end.

The monorepo trick that makes it painless: `@jobber/shared`'s `package.json` points
`main`/`types` at the **raw `src/index.ts`**, not a compiled `dist/`. Vite and tsx
both read TypeScript directly, so the shared package needs no build step in dev.

### 3. Validate at every boundary

The rule (from CLAUDE.md): *every external input crosses a Zod boundary.* In
Phase 0 that's the `apiGet` helper:

```ts
return schema.parse(await res.json()); // backend lied about the shape? throw HERE, loudly
```

A mismatch surfaces at the fetch site, not three components deep as `undefined`.
Later the same principle covers ATS API responses, request bodies, and LLM output.

### 4. Fastify's type provider = the "Pydantic moment"

```ts
const app = Fastify().withTypeProvider<ZodTypeProvider>();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
```

Those ~4 lines are one-time bootstrap. Afterward, any route that declares a Zod
schema gets **automatic runtime validation + a typed handler** from that one
schema — exactly how FastAPI reads Pydantic models. (No routes use it yet; the
payoff lands in Phase 1.)

### 5. TanStack Query owns server state

```ts
useQuery({ queryKey: ["health"], queryFn: () => apiGet("/api/health", HealthSchema) });
```

- `queryKey` is the **cache identity** — anything keyed `["health"]` shares one
  cached result and one in-flight request (dedupe).
- You get `data` / `isPending` / `isError` for free; no hand-rolled loading state.
- Rule of thumb for this project: **server data lives in TanStack Query, local UI
  state lives in `useState`** — reach for nothing fancier until it hurts.

### 6. The dev proxy makes CORS a non-issue

React (`:5173`) and Fastify (`:3001`) are different origins in dev — normally a CORS
problem. `vite.config.ts` proxies `/api/*` → `:3001`, so the browser only ever sees
one origin. In production, nginx does the identical proxy, so **the frontend never
needs to know a backend URL** in any environment.

### 7. Secrets discipline from commit #1

`.env` (real secrets) is gitignored; `.env.example` (blank template) is committed.
Getting `.env` ignored in the *first* commit means a key can never accidentally
enter git history later. Docker Compose reads `.env` and substitutes
`${DB_PASSWORD}` — the password lives in exactly one gitignored place.

---

## Tooling choices (and the one-sentence "why")

| Choice | Why | Revisit when |
|---|---|---|
| **pnpm** (over npm) | Content-addressed store + hard links (fast, low disk); first-class workspace commands (`-r`, `--filter`); blocks phantom dependencies | — |
| **Biome** (over ESLint+Prettier) | One fast tool, one config, lint + format together | — |
| **Fastify** (over Express/Nest) | FastAPI-like ergonomics: built-in validation, schema-typed routes, structured logging; keeps you close to Node fundamentals | — |
| **Drizzle** (over Prisma) | Thin, SQL-transparent, typed — you learn Postgres, not an abstraction | migrations chafe → Prisma |
| **Zod** | One definition → runtime validation + inferred type + JSON Schema for LLMs | — |
| **Vite** | Instant dev server + HMR; one command to build static files | — |
| **node-cron in-process** (Phase 1) | Single user, ~60 endpoints twice a day; a queue is overkill | jobs need retries/fan-out → BullMQ |
| **Docker Compose, DB-only in dev** | Instant hot-reload for api/web on the host; only Postgres needs a container | full 3-container stack for "prod" (Phase 8) |

**Senior-sounding framing:** "one API container + one DB is deliberately boring —
for a single-user LAN app, splitting into microservices adds failure modes without
value. The portfolio signal comes from clean *internal* boundaries (modules, the
provider abstraction), not container count."

---

## Gotchas we actually hit (and the fix)

These are real debugging stories — good to be able to narrate.

1. **pnpm blocked `esbuild`'s install script.** Modern pnpm refuses package
   `postinstall` scripts by default (supply-chain safety). `tsx`/`drizzle-kit`
   need esbuild's native binary, so we opted in explicitly:
   ```yaml
   # pnpm-workspace.yaml
   allowBuilds:
     esbuild: true
   ```
   *Lesson:* if a tool "can't find its binary," an unapproved build script is the
   usual cause.

2. **`fastify-type-provider-zod@7` requires Zod 4; the plan installed Zod 3.**
   Server crashed at boot: `does not provide an export named 'safeEncode'`. Fixed
   by upgrading Zod to 4 workspace-wide. *Lesson:* "the sketch shows intent, the
   docs win on syntax" — the ecosystem moved from Zod 3 → 4.

3. **A hidden Zod version split in the web app.** Web had no direct `zod` dep, so
   `import { z } from "zod"` resolved to a stray hoisted **Zod 3**, which type-
   clashed with `@jobber/shared`'s **Zod 4**. Fixed by adding Zod 4 as a direct
   dep in web. *Lesson:* in a monorepo, a shared library's types must come from a
   **single** version — pin it explicitly in every package that touches it.

4. **Vite template shipped `oxlint` + strict TS 6 defaults.** Removed oxlint (we
   standardize on Biome); dropped the now-deprecated `baseUrl` (path aliases work
   under `moduleResolution: bundler` without it).

5. **The badge didn't flip red at first.** Two TanStack Query defaults masked it:
   it retries failed requests 3× with backoff, and it *pauses* interval refetch
   when the tab is backgrounded. For a liveness probe both are wrong, so:
   `retry: false` and `refetchIntervalInBackground: true`. *Lesson:* know your
   library's defaults; they're tuned for the common case, not every case.

---

## Likely interview questions (with the answer you should be able to give)

**Q: Why TypeScript on both the frontend and backend?**
One language and toolchain, and — the killer feature — **shared types**. A
`JobPosting` is defined once in a shared package; change its shape and the compiler
flags every break on both sides in the same commit. A Flask + JS split can't do
that.

**Q: What does `z.infer<typeof Schema>` actually do?**
Bridges Zod's runtime validator (a value) into a static type. `typeof Schema` grabs
the schema's inferred type; `z.infer` unwraps it into the plain object type. Result:
the type is *derived from* the validator, so they can't drift.

**Q: How do you validate data crossing a boundary?**
Every external input is parsed through a Zod schema at the edge — API responses via
`apiGet`'s `schema.parse()`, and (later) request bodies via Fastify's Zod type
provider, ATS responses, and LLM output. Invalid data throws at the boundary, not
deep in the app.

**Q: Why a monorepo, and how do packages share code without a build step?**
pnpm workspaces let `apps/*` import `@jobber/shared` as a local package. Its entry
points at raw `src/*.ts`; Vite and tsx consume TypeScript directly, so no dev build
is needed. Production bundlers inline it.

**Q: How do you handle CORS between the React app and the API?**
I don't — I avoid it. In dev, Vite proxies `/api/*` to the API port; in prod, nginx
proxies `/api/` to the api container. The browser always sees one origin, so CORS
never applies and the frontend needs zero environment awareness.

**Q: What is TanStack Query and why use it?**
A server-state library: caching, deduping, background refetch, and
loading/error states out of the box, keyed by `queryKey`. Without it you hand-roll
those for every endpoint. Rule: server data → Query, local UI state → `useState`.

**Q: How are secrets managed?**
`.env` holds real values and is gitignored from the first commit; `.env.example` is
the committed template. Docker Compose substitutes `${DB_PASSWORD}` at runtime. The
Anthropic key (Phase 2) never reaches frontend code — the browser only talks to our
API.

**Q: Why only Postgres in Docker during development?**
The api and web dev servers run natively for instant hot-reload; only Postgres needs
a container. The full three-container Compose stack (api + web + db) is for the
"deployed" homelab mode. Data survives restarts via a named volume.

**Q: Why pnpm over npm?**
Content-addressed global store with hard-links (fast installs, minimal disk),
first-class workspace commands (`-r`, `--filter`), and it prevents "phantom
dependencies" — code can only import packages it actually declared, because
`node_modules` isn't flattened.

**Q: Why Drizzle over Prisma?** *(you'll implement this in Phase 1)*
Drizzle is a thin, typed wrapper where the generated SQL is always visible, so I
learn Postgres rather than an abstraction over it. Prisma hides more. Trade-off
noted in the decisions log: revisit if migrations get painful.

---

## Commands you'll reuse

```powershell
pnpm dev                       # start api + web in parallel (root script)
pnpm -r typecheck              # typecheck every package
pnpm biome check --write .     # lint + format the whole repo (pre-commit gate)
pnpm --filter api dev          # run just the api
pnpm --filter web add <pkg>    # add a dep to just the web app
docker compose up -d db        # start Postgres (Docker Desktop must be running)
docker compose exec db psql -U jobber -c "select 1"
```

---

## What's NOT done yet (so you're not surprised)

- No database tables — Phase 1, Step 1.1 (Drizzle schema + first migration).
- `server.ts` is still one file; it splits into Fastify **plugins** per module in
  Phase 1.
- shadcn/ui not installed yet — deferred to Step 1.7 (first real UI) where its
  components are actually used, to keep the Phase 0 diff focused.
- No tests yet — they arrive where they "pay rent" (normalizers, prefilter, upsert
  logic) starting in Phase 1.
