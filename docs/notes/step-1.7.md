# Step 1.7 — First real UI: study notes (+ Phase 1 wrap-up)

> How Jobber grew a face: three pages that read and write real data. Written for
> a junior dev coming from Python — every React/frontend term gets defined the
> first time it appears, and the *why* matters as much as the *how*. By the end
> you should understand component composition, TanStack Query's cache, and the
> mutation→invalidation loop well enough to defend them in an interview. The
> final section closes out all of Phase 1.

**Deliverable:** a running dashboard at `localhost:5173` with a sidebar and three
pages — **Jobs** (browse/filter postings), **Companies** (poll health), and
**Pipeline** (your 38 applications as status columns, click a card to change
status). Changing a status writes to the database and every card updates live,
no reload.

```
Browser (React) ──useQuery──▶ /api/jobs · /api/companies · /api/applications
        │                          (Vite proxies /api → Fastify :3001)
        └──useMutation (PATCH)──▶ /api/applications/:id/status
                                    └─▶ on success: invalidate → refetch → UI updates
```

Files added this step:

```
apps/web/src/
├── lib/utils.ts                 # cn() — the class-name helper
├── lib/api.ts                   # +apiSend() for mutations
├── components/
│   ├── Layout.tsx               # sidebar + <Outlet/>
│   └── ui/                      # hand-written shadcn-style primitives
│       ├── badge.tsx  button.tsx  card.tsx  table.tsx  dialog.tsx
├── pages/
│   ├── JobsPage.tsx  CompaniesPage.tsx  PipelinePage.tsx
└── App.tsx                      # the route table
apps/api/src/modules/companies/  # service.ts + routes.ts (GET /api/companies)
```

---

## Part 0 — Vocabulary you need first

- **Component:** a function that returns UI (JSX). The unit of a React app. Think
  of it as a Python function that returns HTML, except it can hold state and
  re-run when that state changes.
- **JSX:** the HTML-in-JavaScript syntax (`<div className="...">`). It compiles to
  function calls. `className` not `class` because `class` is a JS keyword.
- **Props:** the arguments passed to a component (`<Badge variant="green">`).
  Read-only from the child's view.
- **State:** data a component remembers between renders, created with `useState`.
  Changing it triggers a re-render. (No Python analog — Flask is stateless
  per-request; React components are long-lived in the browser.)
- **Hook:** a function starting with `use…` that plugs into React's machinery
  (`useState`, `useQuery`, `useMutation`). Rules: only call them at the top level
  of a component, never in loops/conditions.
- **Render:** React calling your component function to compute what the UI should
  look like. Happens on mount and after every state change.
- **Controlled input:** a form element whose value is driven by React state (not
  the DOM). You read it from state and write it back on every change. The
  opposite (letting the DOM own the value) is "uncontrolled".
- **Client-side routing:** changing the page (URL + content) without a full
  browser reload. React Router swaps components in place. The sidebar stays
  mounted; only the main area changes.
- **Portal:** rendering a component's DOM somewhere else in the tree (e.g. at
  `<body>` root) while keeping it logically a child. Modals use this so they
  escape parent `overflow:hidden`/stacking.
- **Server state vs UI state:** *server state* is data that lives in the database
  and you cache locally (jobs, applications) — TanStack Query's job. *UI state* is
  ephemeral browser-only stuff (which toggle is on, which dialog is open) —
  `useState`'s job. Keeping them separate is the mental model that makes this
  code simple.
- **Invalidate:** tell TanStack Query "this cached data is stale, refetch it." The
  mechanism behind live updates.

---

## Part 1 — Component composition and the UI primitives

### 1.7a Why so many tiny files in `components/ui/`

`badge.tsx`, `button.tsx`, `card.tsx`, `table.tsx` are each a handful of lines
wrapping a native element with Tailwind classes. Why not just write `<div
className="rounded-lg border …">` everywhere?

Because **composition beats repetition**. Define `<Card>` once and every card in
the app looks consistent; restyle all of them by editing one file. This is the
same instinct as extracting a Python helper function instead of copy-pasting a
block. React's whole model is: build small components, compose them into bigger
ones.

These are **shadcn-style** components. shadcn/ui's philosophy is unusual: it's not
an installed library you import from `node_modules`; it's a pattern where **you
copy the component source into your own repo and own it**. We did exactly that by
hand (on Tailwind v4), so `Card` is *our* code we can read and change — no black
box. The one place we lean on a real library is the Dialog (Part 5), because
accessible modals are genuinely hard to hand-roll.

### 1.7b The `cn` helper (`lib/utils.ts`)

```ts
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

Every primitive ends with `className={cn("my default classes", className)}`. Two
libraries, one job:
- **clsx** joins class names and drops falsy ones, so you can write conditional
  classes: `cn("px-2", isActive && "bg-black")`.
- **tailwind-merge** resolves *conflicts* so the last wins: `cn("p-2", "p-4")` →
  `"p-4"`, not both. Without it, a component's default `p-2` and a caller's
  override `p-4` would both land in `class` and the CSS cascade would pick
  unpredictably.

Together they're what lets a component have sensible defaults *and* accept a
`className` prop that cleanly overrides them.

### 1.7c Typed style variants with `cva`

`badge.tsx` and `button.tsx` use `class-variance-authority`:

```ts
const badgeVariants = cva("base classes", {
  variants: { variant: { green: "bg-green-100 …", red: "bg-red-100 …" } },
  defaultVariants: { variant: "neutral" },
});
```

`cva` maps a `variant` prop to a class string, and — crucially — its TypeScript
types make `<Badge variant="green">` autocomplete and `<Badge variant="purple">`
a compile error. It's the typed-enum pattern applied to styling.

---

## Part 2 — Routing: Layout + Outlet (`App.tsx`, `Layout.tsx`)

```tsx
<Routes>
  <Route element={<Layout />}>
    <Route index element={<Navigate to="/jobs" replace />} />
    <Route path="/jobs" element={<JobsPage />} />
    <Route path="/companies" element={<CompaniesPage />} />
    <Route path="/pipeline" element={<PipelinePage />} />
  </Route>
</Routes>
```

- **Nested routes.** The parent `<Route element={<Layout/>}>` has no path — it
  wraps its children in the shared shell. Inside `Layout` there's an `<Outlet/>`,
  which is React Router's "render the matched child route *here*" slot. Navigate
  from `/jobs` to `/pipeline` and only the `<Outlet/>` content swaps; the sidebar
  never re-mounts. (Python analog: `Outlet` is like a Jinja `{% block content %}`
  that the child template fills — except it happens live in the browser, no
  round-trip.)
- **`index` route** makes `/` redirect to `/jobs` — the default landing page.
- **`NavLink`** (in `Layout.tsx`) is a link that knows whether it's active:
  `className={({ isActive }) => isActive ? "…highlighted" : "…"}`. The router
  tracks which route matches the URL, so the current page's nav item highlights
  itself with zero manual wiring.

The nav is **data-driven** — a `NAV` array `.map`ped to links — so adding a page
is "add an entry + a `<Route>`", not copy-pasted JSX.

---

## Part 3 — Reading server data with TanStack Query

Every page's data comes through one hook. Jobs:

```ts
const { data, isPending, isError } = useQuery({
  queryKey: ["jobs", { openOnly, candidateOnly }],
  queryFn: () => apiGet(`/api/jobs?${qs}`, JobListSchema),
});
```

### 3.7a Why not just `fetch` in a `useEffect`?

You *could*, but you'd hand-write loading flags, error handling, caching, and
refetching every time. TanStack Query gives you all of that: `isPending`/`isError`
states, an in-memory cache, request de-duplication, and background refetching —
for free. Think of it as the server-state layer Flask never needed (because Flask
re-renders the whole page server-side); in a single-page app *you* own the cached
copy of server data, and this library manages it.

### 3.7b The queryKey is the cache identity (the key idea)

`queryKey` is how TanStack Query names a piece of cached data. **Anything with the
same key shares the same cache entry.** That's why the Jobs key includes the
filters: `["jobs", { openOnly, candidateOnly }]`. Flip a toggle → the key changes
→ Query fetches (and caches) *that combination* separately. Flip back → the
previous key's result is served instantly from cache, no network. If the key were
just `["jobs"]`, toggling would either not refetch or would clobber one cache
entry — the filters *belong* in the identity of the data.

This is worth sitting with: **the query key models "which data is this".** Get it
right and caching + refetching mostly just work.

### 3.7c Server-side filtering — a deliberate deviation from the plan

The plan sketched "fetch all jobs, filter client-side with toggles." With **7,249
postings** in the real DB, shipping all of them to the browser to hide most is
wasteful and janky. So the toggles instead drive **querystring params** the server
filters on (`?status=open&candidate=true`), and the key includes those params.
The page also caps rendering at 400 rows with a "showing first 400" note — even
585 candidate rows is a lot of DOM.

The lesson: **filter where the data is.** Cheap, indexed filters (status,
companyId) belong in SQL; only pull what you'll show. Knowing when the "simple"
approach (fetch-all) stops scaling — and moving the work to the server — is the
senior instinct.

### 3.7d Response validation on the client too

`apiGet(path, JobListSchema)` parses the response through a Zod schema imported
from `@jobber/shared` — the *same* schema the API used to serialize it. If the two
ever drift, the client throws loudly at the boundary instead of rendering
`undefined` three components deep. Both ends of the wire, one schema. This is the
CLAUDE.md §4 rule ("every external input crosses a Zod boundary") applied to the
browser: the API's response is external input to the web app.

---

## Part 4 — Writing data: the mutation → invalidation loop (`PipelinePage.tsx`)

This is the most important pattern in the whole UI, and the Pipeline page exists
to demonstrate it.

```ts
const queryClient = useQueryClient();

const mutation = useMutation({
  mutationFn: (vars) =>
    apiSend(`/api/applications/${vars.id}/status`, "PATCH",
            { status: vars.status }, ApplicationWithEventsSchema),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ["applications"] });
  },
});
```

- **`useMutation`** is TanStack Query's tool for *writes* (as `useQuery` is for
  reads). `mutation.mutate({ id, status })` fires the PATCH; `mutation.isPending`
  disables the select while it's in flight.
- **`onSuccess` → `invalidateQueries(["applications"])`** is the magic. After the
  server confirms the change, we mark the `["applications"]` query stale. TanStack
  Query refetches it, and **every component reading that query re-renders with
  fresh data** — the cards regroup into their new columns, and the open dialog's
  timeline shows the newly-appended event. No manual "update this card" code, no
  page reload. You change data on the server and declare "that query is now
  stale"; the UI reconciles itself.

We verified this live: changing IMA's status to *interview* moved its card from
the applied column (37→36) to interview (0→1) and added a `note — status →
interview` row to the timeline, all from one select change. That round trip —
**mutate → server writes (event + column, transactionally, from step 1.6) →
invalidate → refetch → UI updates** — is the spine of every write-capable page
you'll build.

### 4.7a Why track only `selectedId`, not the whole application

The dialog stores `const [selectedId, setSelectedId] = useState<string|null>` and
looks the application up from the query cache each render:
`const selected = data?.find(a => a.id === selectedId)`. If we'd copied the whole
application object into state instead, it would go *stale* the moment the mutation
refetched — the dialog would show the old status. By keeping only the id and
deriving the rest from the single source of truth (the cache), the dialog always
reflects current data. **Store the reference, derive the data.**

### 4.7b Controlled inputs

The status `<select value={selected.status} onChange={…}>` and the Jobs toggles
`<input type="checkbox" checked={openOnly} onChange={…}>` are *controlled*: React
state is the source of truth for their value, and every change flows through an
`onChange` handler. You never read the DOM to find "what's selected" — you read
state. This is the React way and it's why the select instantly reflects a
mutation's result.

---

## Part 5 — The Dialog, portals, and accessibility (`ui/dialog.tsx`)

The modal wraps **Radix UI**'s dialog primitive. Radix hands us the genuinely
hard parts for free: focus trapping (Tab stays inside the modal), Escape-to-close,
click-outside-to-close, `aria` roles for screen readers, and body scroll lock. We
supply only styling.

`DialogContent` renders inside `<DialogPrimitive.Portal>` — a **portal** puts the
overlay + panel at the `<body>` root instead of nested where we wrote it. That's
why a modal can cover the whole screen even though it's declared deep inside the
Pipeline page: it escapes every parent's `overflow` and stacking context. (When
we tested, the dialog didn't show up under `<main>` in the accessibility tree —
because it correctly lives at the body root via the portal.)

---

## Part 6 — The companies endpoint (`modules/companies/`)

The `/companies` page needed data that didn't exist yet, so step 1.7 added a small
read endpoint. `listCompanies()` joins three facts per company:
- the company row (name, tier, ATS type),
- a **single grouped query** counting its open postings (`GROUP BY company_id`) —
  not one count query per company (that'd be the N+1 trap from step 1.6),
- its health from the **latest** `poll_runs` row: `manual` if not pollable,
  `failing` if its name is in that run's `failures` array, else `ok` (or
  `unknown` if we've never polled).

A typed `Record<CompanyPollStatus, …>` in the page maps each status to a badge
colour — and because it's keyed by the union type, the compiler forces you to
handle every status. All 68 companies came back `polling ok` with sensible open
counts (Databricks 789, OpenAI 724).

---

## Part 7 — A real debugging lesson: the pnpm + Vite phantom dependency

When we first loaded the app, the page was **blank with no console error**. The
network tab told the story: `@radix-ui/react-dialog` returned **500** from Vite's
dependency pre-bundler, which broke the whole import graph (App imports Pipeline
imports Dialog imports Radix → one failure blanks everything).

The Vite log had the real cause: `Failed to resolve import "tslib"`. Radix's
pre-bundled output references `tslib` (a tiny TypeScript runtime-helpers library),
but under **pnpm's strict, non-flat `node_modules`**, `tslib` was a *phantom
dependency* — present transitively but not resolvable where Vite's optimizer
looked. The fix: add `tslib` as a direct dependency of `apps/web`, clear Vite's
`node_modules/.vite` cache, and restart. Then everything rendered.

Two takeaways worth keeping:
- **A blank page with no console error usually means a module-graph/build failure,
  not a runtime bug** — check the network tab and the dev-server log, not just the
  browser console.
- **pnpm's strictness is a feature** (it stops you accidentally depending on things
  you didn't declare), but it occasionally surfaces a transitive dep a tool
  assumed was hoisted. The fix is almost always "declare the thing you actually
  use."

---

## Part 8 — How you verify it (the checkpoint)

Run both apps: `pnpm dev` at the repo root (starts API on :3001 and web on :5173).
Then in the browser at `localhost:5173`:

1. **/jobs** — table of open candidate postings; toggle "Candidates only" off and
   watch the count jump (a new query key → refetch); titles link out to the ATS.
2. **/companies** — 68 rows with tier, open-job counts, and `polling ok` badges.
3. **/pipeline** — your 38 applications in status columns (37 applied, ApartmentIQ
   in rejected). Click a card → a dialog opens with the event timeline and a
   status dropdown. Change the status → the card jumps to its new column and the
   timeline gains an event, with no reload. That's the checkpoint: *you triaged a
   real posting and moved a real application from the browser.*

Everything above was verified end-to-end in-browser during the build (including
the status-change round trip, which was then reverted so your data stayed
accurate: 37 applied / 1 rejected, 39 events).

---

## Phase 1 — complete ✅

With step 1.7 done, all of Phase 1 is built, verified, and documented:

| Step | What | Note |
|---|---|---|
| 1.1 | Drizzle schema + first migration | [phase-1.md](phase-1.md) |
| 1.2 | Seed 68 target companies | [phase-1.md](phase-1.md) |
| 1.3 | ATS clients + normalizer | [phase-1.md](phase-1.md) |
| 1.4 | Poll runner: diff + upsert + close + prefilter | [phase-1.md](phase-1.md) |
| 1.5 | Scheduling (node-cron) + ntfy notifications | [step-1.5.md](step-1.5.md) |
| 1.6 | Tracker import + CRUD + jobs routes | [step-1.6.md](step-1.6.md) |
| 1.7 | First real UI (jobs / companies / pipeline) | this file |

**What Jobber can do now, end to end:** twice a day it polls ~68 real ATS boards,
stores every posting without duplicates, closes vanished ones, flags candidates
with the prefilter, records a `poll_runs` audit row, and pushes a phone
notification for new candidates — all idempotently. Your 38 real applications live
in an event-sourced pipeline. And a three-page dashboard lets you browse the
7,000+ postings, watch board health, and work your application pipeline with live
updates.

**The through-lines worth remembering from Phase 1:**
- *Every external input crosses a Zod boundary* — ATS JSON, request bodies, query
  strings, the applications file, and now API responses on the client.
- *Idempotency and audit trails* — the poller and the import can run forever
  safely; `poll_runs` and `application_events` record what happened.
- *One schema, both sides* — `@jobber/shared` types the API and the web app from a
  single definition; drift becomes a compile error.
- *Denormalize deliberately, keep a source of truth* — the event log is truth, the
  status column is a fast mirror, kept in sync transactionally.

**What's next — Phase 2 (the AI layer):** the `packages/ai` provider interface,
forced-structured-output scoring against your profile, prompts as versioned files,
the `ai_runs` cost ledger, and a triage page. Your `JobFinder/config.json`
profile and the already-scored roles are the raw material waiting for it.
