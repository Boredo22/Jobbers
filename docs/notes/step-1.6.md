# Step 1.6 — Tracker import + CRUD: study notes

> How your job-application pipeline moved out of a spreadsheet and into the API.
> Written for a junior dev: every new word gets defined the first time it shows
> up, and we care about *why* as much as *how*. By the end you should be able to
> re-implement this and defend the "event log vs. status column" design in an
> interview — it's the most interview-worthy idea in the whole phase.

**Deliverable:** three HTTP endpoints and a one-time import script that together
turn your applications into queryable data:

| Method & path | What it does |
|---|---|
| `GET /api/applications` | the whole pipeline, newest first, each with its event timeline |
| `POST /api/applications` | record a new application (opens its timeline with an "applied" event) |
| `PATCH /api/applications/:id/status` | change status — writes an event *and* updates the status column |
| `GET /api/jobs?status=&candidate=&companyId=` | list postings for the UI, with the prefilter verdict attached |
| `pnpm --filter api import:applications` | load `data/applications.json` into the DB (idempotent) |

Files:

```
packages/shared/src/index.ts          # +application & job-list schemas (the wire contract)
apps/api/src/modules/tracker/
  ├── service.ts                       # all DB logic (the interesting part)
  └── routes.ts                        # thin Fastify plugin over the service
apps/api/src/modules/jobs/
  ├── service.ts                       # list + candidate filter
  └── routes.ts                        # thin plugin
apps/api/src/scripts/import-applications.ts
apps/api/data/applications.json        # EXAMPLE rows for now — you replace these
```

---

## Part 0 — Vocabulary you need first

- **CRUD:** Create, Read, Update, Delete — the four basic things an API does to a
  resource. This step does C (POST), R (GET), and a specialized U (PATCH status).
  We don't expose Delete (you don't delete job applications; you mark them
  rejected/ghosted).
- **REST-ish routing:** the convention that a *noun* (`/api/applications`) plus an
  *HTTP verb* (GET/POST/PATCH) describes the action. GET reads, POST creates,
  PATCH partially updates.
- **PATCH vs PUT:** PUT replaces a whole resource; PATCH changes *part* of it. We
  only touch the status, so PATCH.
- **Denormalized:** storing a piece of data in more than one place for speed, even
  though it could be derived. Our `applications.status` column is denormalized —
  it *duplicates* information that already lives in the event log. (The opposite,
  "normalized", means every fact lives in exactly one place.)
- **Source of truth:** when the same fact is stored twice, *one* copy is declared
  authoritative and the other is a convenience mirror. Here: the **event log is
  the source of truth**, the status column is the mirror.
- **Append-only log:** a table you only ever INSERT into, never UPDATE or DELETE.
  History accumulates; you reconstruct current state by reading the events. This
  is the same idea as event sourcing / an audit trail / a git history.
- **Transaction:** a group of database writes that either *all* succeed or *all*
  roll back — never half. Written `BEGIN … COMMIT` in SQL; `db.transaction(...)`
  in Drizzle. (Python analog: SQLAlchemy's `session.begin()` block.)
- **Idempotent (recap):** running it twice leaves the same end state as once. The
  import script is idempotent; the CRUD endpoints are deliberately *not* (POSTing
  twice creates two applications — that's correct, you might apply twice).
- **N+1 query problem:** the classic performance bug where you run 1 query to get
  a list, then 1 more query *per row* to get its children — 1+N queries. We avoid
  it by fetching all children in a single `IN (...)` query and grouping in memory.
- **Snapshot column:** a field copied in at creation time so the row stays
  meaningful even if the thing it was copied from changes or never existed. Our
  `companyName`/`roleTitle` on `applications` are snapshots.

---

## Part 1 — The big idea: event log is truth, status is a mirror

This is the design worth really understanding. Look at the two tables (from step
1.1's `schema.ts`):

```ts
applications        { id, companyName, roleTitle, channel, status, appliedAt, ... }
application_events  { id, applicationId, type, occurredAt, detail }
```

An application has **one** `status` column (`applied`/`screen`/`interview`/…) and
**many** events in `application_events`.

### 1.6a Why store status twice?

You could store status *only* as a column, updating it in place. Simple — but you
lose history: once you overwrite `applied` with `rejected`, you can never answer
"when did they apply?" or "how long between screen and rejection?".

You could store *only* events and compute the current status by reading the latest
one. Full history — but every "what's the current status?" read (and the pipeline
board renders dozens of these) has to scan and reduce the event list.

We take **both**, and assign roles:

- **`application_events` is append-only and authoritative.** Every meaningful thing
  that happens — applied, auto-acknowledgment, screen invite, rejection, a note —
  becomes a new row, timestamped. Nothing is ever overwritten. This is your
  history, your audit trail, and (Phase 4) the raw material for analytics like
  "time to first response" and "response rate by channel".
- **`applications.status` is a denormalized cache of "where is this now".** The UI
  reads it directly — one column, no reduction. It's *derived* data we keep in
  sync by hand.

The rule that keeps this honest: **you never change the status column without also
appending the event that justifies it, and you do both in one transaction.** If
the two writes could happen independently, they'd eventually drift and the mirror
would lie. The transaction makes "append event + update column" a single atomic
step. That pairing is the heart of `service.ts`.

> This is a scaled-down version of a real architectural pattern called
> **event sourcing** with a **read model** (a.k.a. CQRS). You don't need the
> jargon, but if an interviewer says it, you've built one.

---

## Part 2 — The shared schemas (the wire contract)

Everything the API accepts or returns is defined once in
`packages/shared/src/index.ts`, and both apps import it. New this step:

- **enums** mirroring the DB: `ApplicationChannelSchema`, `ApplicationStatusSchema`,
  `ApplicationEventTypeSchema`. (The DB's `schema.ts` owns the column definitions;
  shared owns the wire contract. They must be kept in step by hand — a comment in
  each says so.)
- **`ApplicationCreateSchema`** — the POST body. Only the four facts you *always*
  know (companyName, roleTitle, channel, and implicitly the time) are required;
  everything else is `.optional()`.
- **`ApplicationSchema` / `ApplicationWithEventsSchema`** — the response shapes.
  `.extend({ events: [...] })` builds the with-timeline shape from the base one, so
  the base fields are declared once.
- **`ApplicationStatusUpdateSchema`** — the PATCH body: `{ status, detail? }`.
- **`JobListItemSchema` / `JobsQuerySchema`** — for the jobs endpoint (Part 5).

### 2.6a The `z.coerce.date()` trick (dates over the wire)

JSON has no date type — dates travel as strings like `"2026-05-14"`. In the
response schemas we write `appliedAt: z.coerce.date()`. "Coerce" means: if you
hand me a string, parse it into a real `Date` first, then validate. This is why
the same schema works in both directions — the DB hands us `Date` objects going
out, and the web app hands strings coming back in, and both end up as `Date`.

---

## Part 3 — `tracker/service.ts`, function by function

The route files are deliberately boring; the logic lives here.

### 3.6a `statusToEventType` — bridging two enums that don't line up

```ts
export function statusToEventType(status) {
  switch (status) {
    case "applied":  return "applied";
    case "screen":   return "screen_invite";
    case "rejected": return "rejection";
    default:         return "note";      // interview | offer | ghosted
  }
}
```

The status enum (`applied/screen/interview/offer/rejected/ghosted`) and the event
*type* enum (`applied/auto_ack/rejection/screen_invite/note`) don't map 1:1 — there
are statuses with no dedicated event type. Rather than bloat the event enum, we map
those to a generic `"note"` and record the real transition in the event's `detail`
(`"status → interview"`). The **column** always holds the exact status; the event
type is just the best label for the timeline row. This is a normal real-world
situation: two enums, designed for different jobs, that mostly-but-not-perfectly
overlap.

### 3.6b `withEvents` — avoiding the N+1 query

```ts
const events = await db.select().from(applicationEvents)
  .where(inArray(applicationEvents.applicationId, ids))
  .orderBy(asc(applicationEvents.occurredAt));

const byApp = new Map();
for (const id of ids) byApp.set(id, []);
for (const e of events) byApp.get(e.applicationId)?.push(e);
```

Given a list of applications, we need each one's events. The naive way loops and
queries once per application — 1 query for the list + N for the children = the
**N+1 problem**. Instead we grab *all* the relevant events in **one** query with
`WHERE application_id IN (...)`, then bucket them into a `Map` keyed by
application id. Total: two queries, no matter how many applications. Pre-seeding
the map with empty arrays (`for (const id of ids) byApp.set(id, [])`) guarantees
every application gets an `events: []` even if it has none.

> Why not Drizzle's fancy `db.query.applications.findMany({ with: { events }})`?
> That requires declaring `relations()` in the schema, which this project hasn't
> done yet. The manual join is more code but shows you *exactly* what SQL runs —
> and it's the same two-query shape the ORM would generate anyway.

### 3.6c `createApplication` — the transaction pattern in miniature

```ts
const created = await db.transaction(async (tx) => {
  const [app] = await tx.insert(applications).values({ ... }).returning();
  if (!app) throw new Error("insert returned no row");
  await tx.insert(applicationEvents).values({ applicationId: app.id, type: "applied", ... });
  return app;
});
```

Two writes — the application and its first event — wrapped in
`db.transaction(...)`. Notice `tx` (not `db`) is used inside: every write on `tx`
is part of the same transaction. If the event insert throws, the application
insert is rolled back too — you can never end up with an application that has no
"applied" event. `.returning()` hands back the inserted row so we get its
generated `id` without a second query.

**The `if (!app) throw` line** looks paranoid — a single-row insert obviously
returns one row. It's there because our TypeScript config has
`noUncheckedIndexedAccess` on: destructuring `const [app] = array` gives `app` the
type `Row | undefined`, because *in general* an array might be empty. The guard
both satisfies the compiler and documents the invariant. You'll see this pattern
at every `const [x] = await ...returning()` in the codebase.

### 3.6d `updateApplicationStatus` — the two-write rule, enforced

```ts
const updated = await db.transaction(async (tx) => {
  const [existing] = await tx.select({ id: applications.id })
    .from(applications).where(eq(applications.id, id));
  if (!existing) return null;                 // no such application → 404 upstream

  await tx.insert(applicationEvents).values({
    applicationId: id, type: statusToEventType(status),
    detail: detail ?? `status → ${status}`,
  });
  const [app] = await tx.update(applications).set({ status })
    .where(eq(applications.id, id)).returning();
  if (!app) throw new Error("update returned no row");
  return app;
});
if (!updated) return null;
```

This is the design rule from Part 1 turned into code: **append the event, then
update the column, atomically.** The existence check lives *inside* the
transaction so the "does it exist?" and "update it" steps can't be split by a
concurrent delete. Returning `null` for "not found" lets the route translate it
into a clean 404 — the service layer stays HTTP-agnostic (it knows about data, not
status codes), which is why it returns `null` instead of throwing an HTTP error.

---

## Part 4 — `tracker/routes.ts` (thin on purpose)

```ts
const r = app.withTypeProvider<ZodTypeProvider>();

r.post("/api/applications",
  { schema: { body: ApplicationCreateSchema, response: { 201: ApplicationWithEventsSchema } } },
  async (req, reply) => { reply.code(201); return createApplication(req.body); });
```

Two things to internalize:

1. **`schema: { body, response }` is the "Pydantic moment".** Attaching
   `ApplicationCreateSchema` as the `body` schema means Fastify validates the
   incoming JSON *before your handler runs* — a bad body is an automatic 400 you
   never write. And because we called `.withTypeProvider<ZodTypeProvider>()`,
   `req.body` is fully typed as `ApplicationCreate` inside the handler. One schema,
   both runtime validation and compile-time types. (Coming from FastAPI: this is
   exactly `def handler(body: ApplicationCreate)`.)
2. **The response schema is a contract, not decoration.** Declaring
   `response: { 200: ApplicationWithEventsSchema, 404: ... }` makes Fastify
   *serialize* against that shape — and it's why the 404 branch needs its own
   `404: z.object({ message: z.string() })` entry: the type provider won't let you
   `reply.code(404).send({ message })` unless 404 is a declared response shape.
   That strictness is the point — the set of things a route can return is written
   down.

The routes are so thin because all the judgment lives in `service.ts`. That split
(routes = HTTP glue, service = logic) is the module convention for the whole API.

---

## Part 5 — The jobs endpoint and a computed field

`GET /api/jobs` lists postings for the upcoming UI. The interesting wrinkle:
**`candidate` is not a database column.** It's the verdict of the pure
`isCandidate()` prefilter from step 1.4, computed from title/location/remote.

`jobs/service.ts` therefore does the cheap, indexed filters (`status`,
`companyId`) in SQL, joins `companies` for the name, then computes `candidate` in
memory and filters on it there:

```ts
const conditions: SQL[] = [];
if (query.status)    conditions.push(eq(jobPostings.status, query.status));
if (query.companyId) conditions.push(eq(jobPostings.companyId, query.companyId));

const rows = await db.select({ ...columns, companyName: companies.name })
  .from(jobPostings)
  .innerJoin(companies, eq(jobPostings.companyId, companies.id))
  .where(conditions.length ? and(...conditions) : undefined)
  .orderBy(desc(jobPostings.firstSeenAt));

const withCandidate = rows.map((row) => ({ ...row, candidate: isCandidate(row) }));
if (query.candidate === undefined) return withCandidate;
return withCandidate.filter((r) => r.candidate === query.candidate);
```

- **Conditional WHERE:** we collect only the conditions the caller actually sent
  into an array, then `and(...conditions)` — or pass `undefined` (no WHERE) when
  the array is empty. This is the clean way to build "filters that may or may not
  be present" without string-concatenating SQL.
- **`innerJoin`:** every posting has a company (it's a `NOT NULL` foreign key), so
  an inner join is safe and gives us `companyName` in the same query.
- **Filter in memory only for the computed field.** At a few thousand rows this is
  instant. The note-to-self in the code: if the table ever got huge, we'd persist
  the candidate flag at upsert time instead of recomputing on every request. Knowing
  *when* your simple approach would stop scaling is the senior move — not
  pre-optimizing before it matters.

### 5.6a The `candidate=true` boolean-parsing footgun (again)

Query-string values are always strings: `?candidate=true` arrives as `"true"`.
Same trap as the env booleans in step 1.5 — `z.coerce.boolean("false")` is `true`.
So `JobsQuerySchema` parses it the safe way:

```ts
candidate: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
```

`"true"`/`"false"` are the only accepted values (anything else is a 400), each maps
to a real boolean, and `.optional()` lets the param be omitted entirely (→
`undefined` → "don't filter"). We verified all three cases: `candidate=true` →
585 rows all `true`, `candidate=false` → the rest all `false`, `candidate=maybe`
→ 400.

---

## Part 6 — The import script

`import-applications.ts` is a one-off loader, same shape as the `seed.ts` you
already know: read a JSON file, cross a Zod boundary, insert.

What's specific to it:

- **Idempotency without a unique constraint.** The `companies` seed could lean on
  `UNIQUE(name)` + `onConflictDoNothing`. But `applications` has *no* natural
  unique key — you might legitimately apply to the same company for two different
  roles, or even the same role twice. So we can't ask the database to dedupe.
  Instead the script snapshots the existing `(companyName, roleTitle)` pairs into a
  `Set` and skips any source row already present. Re-running inserts nothing
  (verified: "3 rows in file, 0 inserted, 3 already present"). It also adds each
  inserted key to the set as it goes, so duplicates *within the file* are caught
  too.
- **Linking to companies by name.** It builds a `name → id` map (lowercased for
  case-insensitive matching) and sets `companyId` when the application's company is
  one we track. Applications to untracked companies simply keep `companyId = null`
  — the snapshot columns (`companyName`, `roleTitle`) mean the row is still fully
  readable without the link.
- **Opening the timeline.** Each row gets an `"applied"` event dated to its
  `appliedAt`, and — if the row has a `rejectedAt` or `status: "rejected"` — a
  `"rejection"` event too. All inside a per-row transaction, so a row and its
  events are all-or-nothing.

### 6.6a Important: the shipped data is EXAMPLES

`data/applications.json` currently holds **three obviously-fake placeholder rows**
(ApartmentIQ, "Example Corp", "Placeholder Labs"). Your real 38-row tracker
snapshot wasn't in the repo, so the code is real and tested but the data is a
stand-in. To load your real pipeline:

1. Replace the file's contents with your real rows (same shape: `companyName`,
   `roleTitle`, `channel`, `appliedAt`, optional `status`, `rejectedAt`, `notes`).
2. Because the example rows are already in the DB, clear the table first so you
   don't mix them in:
   `docker exec <db> psql -U jobber -d jobber -c "truncate application_events, applications;"`
3. `pnpm --filter api import:applications`.

---

## Part 7 — How you verify it (the checkpoint)

The plan's checkpoint: "curl the three endpoints; applications present with event
timelines." Concretely (server on port 3001 via `pnpm --filter api dev`):

```bash
# list — every application with its timeline
curl -s localhost:3001/api/applications | jq '.[0]'

# create — returns 201 with an "applied" event opened
curl -s -X POST localhost:3001/api/applications \
  -H 'content-type: application/json' \
  -d '{"companyName":"Acme","roleTitle":"AI Lead","channel":"ats"}' | jq

# change status — writes an event AND flips the column
curl -s -X PATCH localhost:3001/api/applications/<id>/status \
  -H 'content-type: application/json' \
  -d '{"status":"interview"}' | jq '.status, .events'

# jobs, with the computed candidate filter
curl -s 'localhost:3001/api/jobs?status=open&candidate=true' | jq 'length'
```

What we already confirmed end-to-end during the build:
- import: 3 inserted, then re-run 0 inserted (idempotent);
- ApartmentIQ has `["applied","rejection"]` events;
- POST opens an `applied` event; PATCH→interview writes `("note","status → interview")`
  and sets `status=interview`;
- bogus id → 404, bad channel → 400;
- `/api/jobs`: 7249 rows, 585 candidates (all correctly flagged), `candidate=maybe` → 400.

---

## Interview-ready summary

> The tracker stores each application's history as an append-only event log — that
> log is the source of truth — plus a denormalized `status` column the UI reads
> fast. Every status change appends the event *and* updates the column inside one
> transaction, so the mirror can never drift from the truth. The read side avoids
> N+1 by fetching all events in a single `IN (...)` query and grouping in memory.
> The jobs endpoint shows a computed, non-stored field (`candidate`, from the
> prefilter) by filtering the cheap columns in SQL and the derived one in app code
> — with a note on when I'd persist it instead. Routes are thin Zod-validated
> plugins; all logic sits in a service layer that returns `null` for "not found"
> so it stays HTTP-agnostic.
