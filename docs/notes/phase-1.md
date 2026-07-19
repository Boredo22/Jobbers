# Phase 1 — Database, Poller, Prefilter: study notes

> What we built in steps 1.1–1.4, explained slowly and from the ground up. This
> is written for a junior dev: every piece of jargon gets defined the first time
> it appears, and the "why" matters as much as the "how". By the end you should
> be able to re-implement the poller and defend every line in an interview.
>
> (Steps 1.5–1.7 — scheduling/ntfy, tracker import, and the first UI — get their
> own per-step notes as they're built: see `step-1.5.md`, `step-1.6.md`, …)

**Deliverable so far:** a command (`POST /api/admin/poll`) that fetches ~68 real
job boards, stores every posting in Postgres without ever creating a duplicate,
marks vanished postings closed, and flags the ones worth scoring — all repeatable
forever with no side effects on a second run.

```
POST /api/admin/poll
  → runPoll()
    → load active companies from DB
      → for each board (5 at a time): fetch → normalize → UPSERT → close-missing
        → new postings → prefilter → candidate list
    → write one poll_runs audit row
  → return summary { newCount, candidateCount, failures, ... }
```

---

## The four steps at a glance

| Step | What | Key artifact |
|---|---|---|
| 1.1 | Drizzle schema + first migration | `src/db/schema.ts`, `drizzle/0000_*.sql`, `src/db/client.ts` |
| 1.2 | Seed the target companies | `data/companies.json`, `src/scripts/seed.ts` (68 rows) |
| 1.3 | ATS clients + normalizer | `src/modules/poller/{greenhouse,lever,ashby,normalize,http,index}.ts` |
| 1.4 | Poll runner + prefilter | `src/modules/poller/{run,prefilter}.ts`, `poll_runs` table, admin route |

---

## Part 0 — Vocabulary you need first

Before the concepts, here are the words this phase throws around. Skim now, refer
back later.

- **ORM (Object-Relational Mapper):** a library that lets you talk to a SQL
  database using your programming language's objects/functions instead of writing
  raw SQL strings. We use **Drizzle**. (Python analog: SQLAlchemy.)
- **Migration:** a versioned file describing a *change* to your database's
  structure (add a table, add a column, add a constraint). You never hand-edit
  the live database; you write/generate migrations and "apply" them. The folder
  of migrations is the full history of how your schema evolved. (Python analog:
  Alembic.)
- **Schema (two meanings, sadly):**
  1. *Database schema* = the shape of your tables (columns, types, constraints).
  2. *Zod schema* = a validator object that checks data at runtime.
  Context tells you which. This phase uses both heavily.
- **Driver:** the low-level library that actually opens a network connection to
  Postgres and sends bytes. We use `postgres` (a.k.a. postgres.js). Drizzle sits
  *on top* of the driver.
- **Constraint:** a rule the database enforces on your data (e.g. "this column
  must be unique", "this column can't be null", "this value must point to a real
  row in another table").
- **Index:** a data structure the database maintains to find rows fast. A
  **unique index** doubles as a uniqueness *constraint*.
- **Upsert:** "update or insert" — try to insert a row; if it collides with an
  existing one, update that one instead. One word, one SQL statement.
- **Idempotent:** an operation you can run many times and get the same end state
  as running it once. Our whole poller is built to be idempotent.
- **ATS (Applicant Tracking System):** the software companies use to post jobs
  and manage applicants. Greenhouse, Lever, and Ashby are three ATSes, each with
  a public JSON API listing a company's open roles.
- **Normalize:** convert data from several different shapes into one common shape
  your code can handle uniformly.

---

## Part 1 — The database layer (Step 1.1)

### 1.1a Why an ORM at all, and why Drizzle specifically

You *could* write raw SQL strings everywhere. The downsides: no autocomplete, no
type-checking (a typo in a column name explodes at runtime, not compile time),
and you assemble queries by string-concatenation (error-prone, injection-risky).

An ORM gives you typed, autocompleted query-building. **Drizzle** is a
*thin* ORM: the code you write looks almost exactly like the SQL it generates, and
you can always print that SQL. That's the point — you *learn Postgres* instead of
learning a thick abstraction that hides it. (Prisma, the main alternative, hides
more.)

### 1.1b The schema file is the source of truth

`src/db/schema.ts` describes every table in TypeScript:

```ts
export const companies = pgTable("companies", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  atsType: text("ats_type", { enum: ["greenhouse", "lever", "ashby", "manual"] }).notNull(),
  atsToken: text("ats_token"),           // nullable — "manual" companies have no API token
  fitGroup: integer("fit_group"),        // nullable
  active: boolean("active").notNull().default(true),
});
```

Reading this like SQL:
- `uuid("id").defaultRandom().primaryKey()` → the column `id` is a UUID (a random
  128-bit id like `a3f1...`), auto-generated, and it's the **primary key** (the
  one column that uniquely identifies a row).
- `.notNull()` → the column is required.
- `.unique()` → no two rows may share this value (that's a constraint — remember
  it, it matters a lot in Step 1.2).
- `.default(true)` → if you don't provide a value, the DB fills in `true`.
- `{ enum: [...] }` → the value must be one of these strings. **Important:** this
  is a plain `TEXT` column that TypeScript *pretends* is a union type. It is NOT a
  real Postgres `ENUM` type. Consequence: adding a new allowed value later is just
  a code edit, not a database migration. (Simpler; we chose it on purpose.)

**Why UUIDs instead of auto-incrementing `1, 2, 3` ids?** UUIDs don't leak
information (a competitor can't tell how many jobs you have), don't collide if you
ever merge data from two sources, and can be generated before touching the DB.
Trade-off: they're bigger and not human-friendly. Fine here.

### 1.1c The `schema → migration → apply` workflow

Three commands, three concepts:

```bash
pnpm --filter api db:generate   # 1. DIFF schema.ts against the last migration,
                                #    write the SQL needed to catch the DB up
pnpm --filter api db:migrate    # 2. APPLY any not-yet-applied migrations
```

`db:generate` doesn't touch the database — it just writes a `.sql` file into
`drizzle/`. **Read that file.** For us it produced plain, familiar SQL:

```sql
CREATE TABLE "companies" ( "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() ... );
-- ...seven more CREATE TABLEs...
ALTER TABLE "job_postings" ADD CONSTRAINT ... FOREIGN KEY ("company_id") REFERENCES "companies"("id");
CREATE UNIQUE INDEX "job_dedupe" ON "job_postings" ("company_id","external_id");
```

Notice the **order**: all `CREATE TABLE`s first, *then* the foreign-key
constraints, *then* the indexes. That's why the order you define tables in
`schema.ts` doesn't matter — the foreign keys are wired up in a later step, after
every table exists.

> **Foreign key (FK):** a column that must contain a value that exists as a
> primary key in another table. `job_postings.company_id` is an FK to
> `companies.id` — it guarantees every posting belongs to a real company. The DB
> refuses to insert a posting pointing at a company that doesn't exist. This is
> "referential integrity".

### 1.1d The connection: driver + Drizzle

`src/db/client.ts` builds the one database handle the whole app shares:

```ts
export const queryClient = postgres(env.DATABASE_URL); // the driver: owns the connection pool
export const db = drizzle(queryClient, { schema });    // Drizzle wraps the driver + knows your tables
```

- **Connection pool:** opening a DB connection is slow, so the driver keeps a
  handful open and reuses them. `db` is created *once* per process (a module-level
  singleton), so you never open a connection per request.
- A long-running server never closes the pool. A short *script* (like the seed)
  must close it (`await queryClient.end()`) or the Node process hangs forever,
  waiting on those idle connections. That's the difference between a service and a
  script.

### 1.1e The env "config boundary"

`src/lib/config.ts` validates environment variables through a Zod schema *at
import time*:

```ts
export const env = EnvSchema.parse(process.env); // missing DATABASE_URL? crash NOW with a clear message
```

Environment variables are external input, so — per the project rule — they cross a
Zod boundary just like an HTTP body would. A missing/typo'd `DATABASE_URL` fails
loudly at startup instead of surfacing as a confusing `undefined` deep in the
driver. (Python analog: pydantic-settings.)

---

## Part 2 — Seeding data (Step 1.2)

### 2.1 The pipeline: file → validate → transform → insert

Seeding = loading initial data. `data/companies.json` holds 68 companies (your
real target boards, transcribed from your JobFinder tool). `src/scripts/seed.ts`
does four things, in order:

```
read JSON file  →  Zod-validate it  →  map tier→fitGroup  →  idempotent INSERT
```

Each arrow is a lesson:

1. **Read:** `JSON.parse(readFileSync(...))` gives you `unknown` — untrusted data.
2. **Validate:** `CompanySeedFileSchema.parse(raw)`. A typo like
   `"atsType": "greenhous"` throws *here* with a precise error, before a single
   bad row reaches the DB. After this line the data is fully typed.
3. **Transform:** the file speaks your vocabulary (`tier: "A" | "B" | "C"`); the
   DB wants a number (`fitGroup`). The script maps `A→1, B→2, C→3` and stashes the
   original letter in `notes`. Keep external data in its own shape; convert at the
   boundary.
4. **Insert (idempotently):** covered next — it's the important part.

### 2.2 Idempotent inserts: `ON CONFLICT DO NOTHING`

Naive problem: run a plain `INSERT` of 68 rows twice → you get 136 rows. Seeds
need to be safe to re-run. The fix:

```sql
INSERT INTO companies (name, ...) VALUES (...)
ON CONFLICT (name) DO NOTHING;   -- "if a row with this name already exists, skip it"
```

In Drizzle: `.onConflictDoNothing({ target: companies.name })`.

**The catch that makes this a real lesson:** `ON CONFLICT (name)` only works if
there's a **unique constraint on `name`**. Postgres detects a "conflict" by
checking a unique index; with no such index, every insert just succeeds (each row
gets a fresh random `id`, so nothing ever "conflicts") and you'd get duplicates
anyway. So Step 1.2 *forced* a second migration adding `UNIQUE(name)`:

```sql
ALTER TABLE "companies" ADD CONSTRAINT "companies_name_unique" UNIQUE("name");
```

That's the whole reason we needed migration `0001` — a great illustration of
"schema evolves through migrations, driven by a real need."

### 2.3 `.returning()` — how the script reports honestly

```ts
const inserted = await db.insert(companies).values(rows)
  .onConflictDoNothing({ target: companies.name })
  .returning({ id: companies.id });
```

`RETURNING` makes an `INSERT` hand back the rows it wrote. With `DO NOTHING`, only
*actually-inserted* rows come back (skipped ones don't). So `inserted.length` is a
truthful count — which is how run 2 correctly printed `0 newly inserted, 68
already present`. That's your idempotency proof.

---

## Part 3 — The ATS clients (Step 1.3)

### 3.1 The problem: three APIs that agree on nothing

Greenhouse, Lever, and Ashby each return JSON, but shaped differently:

| | Greenhouse | Lever | Ashby |
|---|---|---|---|
| response shape | `{ jobs: [...] }` | `[...]` (bare array) | `{ jobs: [...] }` |
| id type | number | string | string |
| title field | `title` | `text` | `title` |
| description | HTML in `content` | `descriptionPlain` | `descriptionPlain` |
| remote signal | (guess from location) | `workplaceType` | `isRemote` boolean |

We want the rest of the app to *never* care about these differences. Two layers
solve that: **clients** (fetch + validate) and a **normalizer** (map to one shape).

### 3.2 The shared HTTP helper (`http.ts`)

Every client does the same three chores, so they're factored out:

```ts
export async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "jobber-poller/0.1" },
    signal: AbortSignal.timeout(15_000),   // native per-request timeout
  });
  if (!res.ok) throw new AtsFetchError(`HTTP ${res.status} ...`, res.status);
  return res.json();
}
```

- `fetch` is **built into Node 18+** — no `axios` needed.
- `AbortSignal.timeout(15_000)` cancels the request if no response arrives in 15s.
  Without a timeout, one hung board could freeze the entire poll forever.
- `AtsFetchError` carries the HTTP `status`. Why? So callers can branch on the
  *type* of failure: `404` = dead token, no status = network timeout, and (if the
  JSON shape is wrong) a Zod error is thrown instead. **Branch on typed errors,
  never by string-matching error messages.**

### 3.3 Lenient validation (a subtle, important point)

Each client validates the response with a Zod schema that models **only the fields
we use**:

```ts
const GreenhouseJobSchema = z.object({
  id: z.number(),
  title: z.string(),
  absolute_url: z.string().url(),
  location: z.object({ name: z.string() }).nullish(),
  content: z.string().nullish(),
});
```

Key fact: **Zod, by default, silently drops keys it doesn't know about** (it does
*not* error on extra fields). So if Greenhouse adds a new field next month, our
parser ignores it and polling keeps working. We get "tolerate unknown fields" for
free, just by not listing them. (`.nullish()` = "may be null or missing" — use it
for anything that isn't guaranteed present.)

### 3.4 The normalizer: pure functions to one common shape

`normalize.ts` defines the target shape and three mapping functions:

```ts
export type NormalizedPosting = {
  externalId: string; title: string; url: string;
  location: string | null; remote: boolean | null;
  compMin: number | null; compMax: number | null;
  description: string | null; contentHash: string;
};
```

`normalizeGreenhouse`, `normalizeLever`, `normalizeAshby` each take that platform's
raw postings and return `NormalizedPosting[]`. Two properties make these special:

- **They're pure functions.** "Pure" = no network, no clock, no database — same
  input always gives same output. That makes them trivially unit-testable: feed in
  a saved JSON fixture, assert the output. (The network lives in the clients; the
  *logic* lives in pure functions. Keep that seam.)
- **They do the messy per-platform work** so nobody downstream has to: stringify
  Greenhouse's numeric id, pull the title from `text` vs `title`, strip HTML,
  infer `remote`.

Two helpers worth calling out:

```ts
export function stripHtml(input: string): string { /* decode entities, drop tags, collapse spaces */ }
export function contentHashOf(title, description): string {
  return createHash("sha256").update(`${title}\n${description ?? ""}`).digest("hex");
}
```

- `stripHtml` is a pragmatic regex cleaner (not a full HTML parser — the LLM
  scorer just wants readable text).
- `contentHashOf` produces a **fingerprint** of the posting's text. Same text →
  same hash; edited text → different hash. This becomes the "did this posting
  change?" detector in Step 1.4.

### 3.5 The adapter pattern + registry (the senior-signal design)

Three different clients, one uniform interface:

```ts
export type Adapter = (token: string) => Promise<NormalizedPosting[]>;

export const adapters: Record<PollableAtsType, Adapter> = {
  greenhouse: async (t) => normalizeGreenhouse(await greenhouse.fetchJobs(t)),
  lever:      async (t) => normalizeLever(await lever.fetchJobs(t)),
  ashby:      async (t) => normalizeAshby(await ashby.fetchJobs(t)),
};
```

Now the poll runner just writes `adapters[company.atsType](company.atsToken)` and
never touches a platform-specific detail. Adding a fourth ATS later = one new
client file + one new line here. **This "clean internal boundary" is exactly the
kind of judgment interviewers probe for.** (Python analog: a
`dict[str, Callable]` dispatch table.)

> **`Record<PollableAtsType, Adapter>`** is TypeScript for "an object whose keys
> are exactly the pollable ATS types and whose values are all `Adapter`
> functions." `PollableAtsType = Exclude<AtsType, "manual">` — every ATS type
> except `manual` (manual companies have no API to poll).

---

## Part 4 — The poll runner + prefilter (Step 1.4)

This is the heart of Phase 1. `runPoll()` in `run.ts` orchestrates everything.

### 4.1 The one-timestamp trick

```ts
const startedAt = new Date();   // ONE timestamp for the entire run
```

This single value is the linchpin of the whole diff algorithm. Every posting we
see this run gets `lastSeenAt = startedAt`. So later, `lastSeenAt < startedAt`
means *exactly* "we did NOT see this posting during this run." Hold that thought.

### 4.2 UPSERT part 2: `DO UPDATE` + the `excluded` table

Step 1.2 used `DO NOTHING`. The poller needs the fuller version — insert a new
posting, or *refresh* an existing one:

```sql
INSERT INTO job_postings (company_id, external_id, title, content_hash, ...) VALUES (...)
ON CONFLICT (company_id, external_id)
DO UPDATE SET
  last_seen_at = <startedAt>,
  status       = 'open',
  title        = excluded.title,
  content_hash = excluded.content_hash;
```

The magic word is **`excluded`**. It's a special Postgres pseudo-table meaning
"the row you *tried* to insert but couldn't because it conflicted." So
`content_hash = excluded.content_hash` means "overwrite the stored hash with the
freshly-fetched one." In Drizzle:

```ts
.onConflictDoUpdate({
  target: [jobPostings.companyId, jobPostings.externalId],  // the dedupe key (that unique index!)
  set: {
    lastSeenAt: startedAt,
    status: "open",
    title: sql`excluded.title`,
    contentHash: sql`excluded.content_hash`,
    // ...other mutable fields...
  },
})
```

**The most important detail is what's MISSING from `set`: `firstSeenAt`.** Because
we don't overwrite it, an existing posting keeps its *original* discovery time
while everything else refreshes. New postings, on the other hand, get
`firstSeenAt = startedAt` from the INSERT. That difference is how we tell new from
old (next section).

Why is this the dedupe mechanism? The `target` is the `(company_id, external_id)`
unique index from Step 1.1. Running the poll twice can't create duplicates: the
second time, every posting *conflicts* on that key and takes the UPDATE branch
instead of inserting. **That's idempotency, enforced by the database.**

### 4.3 Telling "new" from "refreshed" via `RETURNING`

```ts
.returning({ title, url, firstSeenAt, ... });   // returns BOTH inserted and updated rows
```

For each returned row:

```ts
if (row.firstSeenAt.getTime() >= startedAt.getTime()) {
  // firstSeenAt == startedAt ⇒ this row was just INSERTED ⇒ a genuinely NEW posting
  newCount++;
  if (isCandidate(row)) candidates.push(...);
}
```

Updated rows kept an *earlier* `firstSeenAt`, so they fail this check. Only fresh
inserts pass. That's how `newCount` (7,249 on the first run, 0 on the second) and
the candidate list are computed — no separate "which of these are new?" query.

### 4.4 Closing vanished postings (the timestamp diff)

How do we mark postings that disappeared from a board? Not by comparing arrays in
JavaScript — by one SQL `UPDATE`:

```sql
UPDATE job_postings SET status='closed'
WHERE company_id = <this company>
  AND status = 'open'
  AND last_seen_at < <startedAt>;   -- "wasn't touched this run"
```

Everything we just upserted has `last_seen_at = startedAt`, so it's safe. Anything
still carrying an older timestamp wasn't seen → it's gone from the board → close
it. It's a **soft close** (a `status` flip, not a `DELETE`), so you never lose
history — you can still see and analyze closed roles.

### 4.5 The correctness rule you must be able to explain

The close-`UPDATE` lives **inside** each board's `try` block, **after** a
successful fetch:

```ts
try {
  const postings = await adapters[c.atsType](c.atsToken);
  // ...upsert...
  // ...close-missing UPDATE for THIS company...
  companiesOk++;
} catch (err) {
  companiesFailed++;
  failures.push({ company: c.name, reason: ... });   // log and move on
}
```

Two things fall out of this structure:

1. **Per-company isolation:** one board throwing (404, timeout, garbage JSON) is
   caught, logged to `failures[]`, and the loop continues. One dead board never
   kills the run.
2. **The subtle bug the plan warns about:** if the close-`UPDATE` ran for a board
   that *failed*, a temporary API hiccup would return zero postings and mass-close
   that company's entire job list. By scoping close-missing to (a) one company and
   (b) only the success path, an outage can't corrupt your data. **This is the #1
   thing to be able to articulate about the poller.**

### 4.6 Concurrency with `p-limit` (and why Node needs it)

```ts
const limit = pLimit(5);
await Promise.all(active.map((c) => limit(async () => { /* fetch + upsert one board */ })));
```

- **Node is single-threaded**, but I/O (network calls) is asynchronous — while one
  fetch waits for the network, others can proceed. This is *concurrency* (overlap),
  not *parallelism* (multiple CPU cores). Closer to Python's `asyncio` than to
  threads.
- `p-limit(5)` caps it at **5 boards in flight at once**. Without a cap,
  `Promise.all` would fire all 68 requests simultaneously — rude to the ATS APIs
  and a good way to get rate-limited. With the cap, the full run still finishes in
  ~4 seconds.
- Because Node is single-threaded, incrementing `companiesOk++` or pushing to
  `candidates[]` from inside these async callbacks is safe — there's no true
  parallel write, so no race condition on those variables.

### 4.7 The prefilter: a pure, cheap gate

`prefilter.ts` exports one pure function:

```ts
export function isCandidate(posting: { title; location; remote }): boolean {
  const title = posting.title.toLowerCase();
  if (!containsAny(title, INCLUDE_TITLE_KEYWORDS)) return false;  // must hit the job family
  if (containsAny(title, EXCLUDE_TITLE_KEYWORDS)) return false;   // dodge disqualifiers
  if (posting.remote === false) {                                 // known-onsite?
    return posting.location ? CAPITAL_REGION.test(posting.location) : false;
  }
  return true;                                                    // remote or unknown → keep
}
```

- **Why prefilter before scoring?** LLM scoring (Phase 2) costs tokens/money. A
  cheap keyword+location gate throws out the obvious non-fits (a "Senior Software
  Engineer" in Austin) so you only spend model calls on plausible roles. Of 7,249
  postings, 585 passed.
- **Why keep it lenient?** It only drops the *clearly* wrong ones. Unknown remote
  status (`null`) is kept — better to let the LLM judge than to discard on missing
  data. False negatives (dropping a good job) are worse than false positives here.
- **Why a pure function?** Same reason as the normalizers: no I/O means you can
  unit-test it with a table of `(title, location, remote) → expected boolean`.
  It's on the Phase-1 test list.
- The keyword lists are your real AI-Enablement title cluster, transcribed from
  JobFinder. We store all postings; the prefilter only decides which ones to
  *notify/score*, not which to keep.

### 4.8 The `poll_runs` audit table and the Fastify plugin

Every run writes one row to `poll_runs` (started/finished, companies ok/failed,
new count, candidate count, and a JSON list of failures). This is an **audit
trail**: it powers the Companies page ("which boards are failing?") and proves the
scheduler actually ran.

The trigger is a **Fastify plugin** — a function that receives the app and
registers routes:

```ts
export async function adminRoutes(app: FastifyInstance) {
  app.post("/api/admin/poll", async () => runPoll());
}
// server.ts: app.register(adminRoutes);
```

A "plugin" is just Fastify's word for a composable unit of routes. `server.ts`
stays a thin bootstrap that registers plugins; each feature module owns its own
routes. (This is the modular structure Phase 0's single-file `server.ts` grows
into.)

---

## SQL cheat-sheet (everything past ALTER/JOIN/PK-FK we used this phase)

| Concept | What it does | Where we used it |
|---|---|---|
| `UNIQUE(col)` constraint | forbids duplicate values; enables `ON CONFLICT` | `companies.name`, `(company_id, external_id)` |
| Unique **composite** index | uniqueness across *two* columns together | the `job_dedupe` key |
| `INSERT ... ON CONFLICT DO NOTHING` | idempotent insert (skip dupes) | seeding companies |
| `INSERT ... ON CONFLICT DO UPDATE` | upsert (insert or refresh) | the poller |
| `excluded.<col>` | "the value I tried to insert" inside DO UPDATE | refreshing posting fields |
| `RETURNING <cols>` | make INSERT/UPDATE hand back affected rows | counting new vs skipped |
| Soft delete (`status` flip) | mark inactive instead of `DELETE`, keep history | closing vanished postings |
| `timestamptz` | timestamp *with time zone* (unambiguous instant) | every `*_at` column |
| `jsonb` column | store JSON (arrays/objects) in one column | `poll_runs.failures`, score arrays |

If you can explain the top six of those rows, you've cleared "SQL basics" into
genuinely useful territory.

---

## Gotchas we actually hit (real debugging stories)

1. **Postgres "password authentication failed" — but only from the host.** The
   `.env` password matched everywhere, and connecting *inside* the container
   worked, yet the host couldn't authenticate. Root cause: a **native Windows
   PostgreSQL 16 service** already owned IPv4 `0.0.0.0:5432`, so Docker could only
   bind IPv6 `[::1]:5432`. On Windows `localhost` resolves to IPv4 first, so our
   tools were silently hitting the *wrong* Postgres. *Fix:* moved the container to
   host port **5433** (`docker-compose.yml` + `DATABASE_URL`). *Lesson:* "auth
   fails from one place but not another" often means you're talking to a different
   server than you think — check what's actually listening on the port.

2. **The volume remembered an old password.** Before finding the port clash, we
   saw auth fail because Postgres only sets `POSTGRES_PASSWORD` on the *first*
   initialization of its data volume. The `.env` had been edited afterward, so the
   stored password and the `.env` password had drifted. *Fix (non-destructive):*
   the container accepts local connections without a password, so we `ALTER USER
   jobber WITH PASSWORD '...'` in place rather than wiping the volume. *Lesson:*
   env changes don't retroactively re-initialize a database.

3. **drizzle-kit prints a scary-looking error even on success.** In `strict`
   mode, `db:migrate` echoes a `transformCreateStmt` object right before
   `migrations applied successfully!`. It's noise from its interactive prompt, not
   a failure — the migration applied. *Lesson:* read to the last line before
   panicking; and confirm state independently (we checked `\dt` and row counts).

---

## Likely interview questions (with the answer you should be able to give)

**Q: What makes your poller safe to run repeatedly?**
Two database-enforced guarantees. First, a unique index on
`(company_id, external_id)` plus `INSERT ... ON CONFLICT DO UPDATE` means a second
run refreshes existing rows instead of duplicating them — idempotency enforced by
Postgres, not by application checks. Second, I close vanished postings with a
timestamp diff (`last_seen_at < runStart`) rather than deleting, so re-runs and
history stay clean.

**Q: How do you detect that a posting disappeared from a board?**
One timestamp per run. Everything I see gets `last_seen_at = runStart`; then a
single `UPDATE ... SET status='closed' WHERE last_seen_at < runStart` closes
anything I didn't touch. No array diffing in app code — the database does it.

**Q: What's the bug you specifically guarded against in the close logic?**
Closing postings for a board whose fetch *failed*. A transient API error returns
zero postings; if I closed-missing unconditionally, one hiccup would mark an
entire company's jobs closed. So close-missing runs only inside the per-company
success path, scoped to that one company.

**Q: What is `excluded` in an upsert?**
A Postgres pseudo-table representing the row you attempted to insert. Inside
`ON CONFLICT DO UPDATE`, `SET col = excluded.col` copies the incoming value onto
the existing row. I use it to refresh mutable fields while deliberately leaving
`first_seen_at` out of the SET so original discovery time is preserved.

**Q: Why validate ATS responses, and how leniently?**
External input crosses a Zod boundary. I model only the fields I use; Zod strips
unknown keys by default, so a platform adding fields never breaks polling. A shape
I *do* depend on going missing throws immediately at the parse site.

**Q: Explain the adapter registry.**
Three ATS APIs are reduced to one function type,
`(token) => Promise<NormalizedPosting[]>`, collected in a `Record` keyed by ATS
type. The runner dispatches with `adapters[company.atsType](token)` and knows
nothing platform-specific. Adding an ATS is one file plus one line.

**Q: Why cap concurrency, and how?**
`p-limit(5)` keeps at most five board fetches in flight. Node is single-threaded
with async I/O, so unlimited `Promise.all` would fire all 68 at once — rude and
rate-limit-prone. Five is polite and still finishes in seconds.

**Q: Why is the prefilter a pure function?**
No I/O means deterministic output, so it's unit-testable with a simple input→output
table, and it keeps the runner readable. It's a cheap gate that saves LLM spend by
dropping obvious non-fits before Phase 2 scoring.

**Q: Why UUID primary keys?**
They don't leak row counts, don't collide across data sources, and can be
generated client-side before an insert. The cost is size and readability, which
don't matter here.

---

## Commands you'll reuse

```powershell
pnpm --filter api db:generate      # diff schema.ts → write a new migration SQL file
pnpm --filter api db:migrate       # apply pending migrations
pnpm --filter api seed             # load data/companies.json (idempotent)
pnpm --filter api validate-tokens  # health-check every ATS board (which 404?)
pnpm --filter api dev              # run the API (then POST /api/admin/poll)

# Inspect the database directly:
docker compose exec db psql -U jobber -d jobber -c "\dt"                       # list tables
docker compose exec db psql -U jobber -d jobber -c "select count(*) from job_postings;"
docker compose exec db psql -U jobber -d jobber -c "select * from poll_runs order by started_at;"
```

---

## What's NOT done yet (so you're not surprised)

- **No scheduling or notifications yet** — Step 1.5 adds `node-cron` (poll at 8am
  & 2pm) and ntfy push for the candidates the prefilter flags.
- **No scoring** — the `candidates` list is computed but only counted; enqueuing
  it for LLM scoring is Phase 2.
- **Comp is always `null`** — salary parsing is deliberately deferred to Phase 2
  (the `?includeCompensation=true` data is already in the payload for later).
- **`remote` is heuristic** — Ashby/Lever give real signals; Greenhouse is guessed
  from the location string.
- **No tests yet** — the normalizers and the prefilter are the first Vitest
  targets (they're pure functions, so they're easy), landing where they "pay
  rent".
- **No UI for any of this** — the jobs/companies/pipeline pages are Step 1.7.
```
