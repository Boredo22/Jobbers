# Step 1.5 — Scheduling + ntfy: study notes

> How the poller learned to run itself twice a day and buzz your phone when it
> finds something. Written for a junior dev: every new word gets defined the
> first time it shows up, and we care about *why* as much as *how*. By the end
> you should be able to re-implement this and defend every line in an interview.

**Deliverable:** the `runPoll()` you built in step 1.4 no longer needs a human to
hit `POST /api/admin/poll`. A cron *inside the API process* runs it at 08:00 and
14:00 New York time, and every run that finds new candidate jobs sends a push
notification to your phone via ntfy.

```
API process boots
  → schedulerPlugin registers a node-cron task ("0 8,14 * * *", America/New_York)
      → at 08:00 and 14:00: runPoll()
          → if new candidates found: notify() → HTTP POST → ntfy → phone buzzes
```

Three files do the work:

| File | Role |
|---|---|
| `src/lib/notify.ts` | send one push notification (or silently do nothing) |
| `src/modules/poller/scheduler.ts` | the cron plugin that fires `runPoll` on a timetable |
| `src/lib/config.ts` (edited) | validate the two new env vars |

---

## Part 0 — Vocabulary you need first

- **cron / crontab:** a decades-old Unix convention for "run this command on a
  schedule". A **cron expression** is five (sometimes six) fields describing
  *when*: `minute hour day-of-month month day-of-week`. `0 8,14 * * *` means
  "at minute 0 of hours 8 and 14, every day, every month, any weekday". The `*`
  means "every value of this field".
- **node-cron:** a tiny npm library that reads a cron expression and calls your
  function at those times. It is **in-process** — it lives inside your running
  Node program, it is *not* the operating system's cron daemon. (More on why
  that distinction matters below.)
- **daemon:** a long-running background program (the "d" is for daemon). The OS
  has a real `cron` daemon; we are deliberately **not** using it.
- **ntfy** (pronounced "notify"): a dead-simple push-notification service. You
  pick a **topic** (just a name in a URL, e.g. `ntfy.sh/jobber-7f3a9c2e`), you
  `POST` a message to that URL, and anyone subscribed to that topic in the ntfy
  phone app gets a push notification. No account, no SDK, no API key.
- **timezone:** a schedule is meaningless without one. "8am" in what zone? We
  pin it to `America/New_York` so the poll fires at *your* 8am regardless of
  what timezone the server thinks it's in (a server in UTC would otherwise fire
  at 3–4am your time).
- **plugin (Fastify):** a function that receives the `app` and registers things
  on it. It's Fastify's unit of composition — you saw it with `adminRoutes` in
  step 1.4. A plugin doesn't *have* to add routes; ours adds a background timer
  instead.
- **opt-in / opt-out:** "opt-in" means a feature is **off by default** and you
  must explicitly switch it on. We make the scheduler opt-in so it doesn't fire
  by accident during development.
- **no-op:** "no operation" — a function that intentionally does nothing (and
  returns) under some condition. `notify()` is a no-op when ntfy isn't
  configured.
- **idempotent (recap from 1.4):** running it twice leaves the same end state as
  running it once. The whole reason a *scheduled* poll is safe is that `runPoll`
  is idempotent — firing it 730 times a year can't create duplicate jobs.

---

## Part 1 — The notifier (`src/lib/notify.ts`)

### 1.5a Why ntfy, and why it's almost too simple

Push notifications usually mean Apple/Google's push infrastructure, certificates,
device tokens — a lot of ceremony. ntfy collapses all of that into "POST to a
URL". The message *is* the request body. A few optional HTTP headers control the
rest:

- `Title` → the bold headline
- `Priority` → how loud (`min`, `low`, `default`, `high`, `urgent`)
- `Tags` → emoji shortcodes shown next to the title (`briefcase`, `warning`)
- `Click` → a URL opened when you tap the notification

That's the entire API. Here's the core of our sender:

```ts
export async function notify(n: Notification): Promise<boolean> {
  if (!env.NTFY_URL) return false;          // (1) no-op when unconfigured

  const headers: Record<string, string> = {};
  if (n.title) headers.Title = sanitizeHeader(n.title);
  if (n.priority) headers.Priority = n.priority;
  if (n.tags?.length) headers.Tags = n.tags.map(sanitizeHeader).join(",");
  if (n.click) headers.Click = n.click;

  try {
    const res = await fetch(env.NTFY_URL, { method: "POST", body: n.message, headers });
    return res.ok;                          // (2) true only if ntfy accepted it
  } catch {
    return false;                           // (3) network died? swallow it
  }
}
```

### 1.5b The two rules that make this safe

These are the lines most worth understanding:

**(1) No-op when unconfigured.** `if (!env.NTFY_URL) return false;`
If you haven't set an ntfy URL, `notify()` does nothing and returns. This is what
lets the poller run on a headless server, or on your laptop during development,
with no phone attached and no crash. A feature that's optional should *degrade to
silence*, not to an error.

**(3) Never throw.** The whole body is wrapped in `try/catch`, and even a failed
send just returns `false`. Ask yourself: if ntfy.sh is down for 30 seconds, should
your twice-daily poll of 68 job boards **fail**? Obviously not. The notification is
a *nice-to-have side effect*; the poll is the *real work*. So the notifier is
built to be un-crashable — the worst it can do is fail to buzz your phone. This is
a general principle: **a non-critical side effect must never be able to fail the
critical path.**

### 1.5c The `sanitizeHeader` detail

```ts
function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[^\x20-\x7E]/g, "");
}
```

HTTP header values live on a single line and are historically ASCII-only. A
company name with a newline or an accented character (`Renée`, or a job title
someone pasted with a stray line break) could corrupt the request or split it
into two headers. So for anything that becomes a *header* (title, tags) we strip:

- `[\r\n]+` → carriage returns and newlines become a space (keeps it one line)
- `[^\x20-\x7E]` → anything outside printable ASCII (hex 20–7E) is removed

Note the **message body** is *not* sanitized — bodies can be multi-line UTF-8,
that's fine. Only headers are constrained.

> Python analog: this is the same class of bug as "header injection" you'd guard
> against in a Flask response — untrusted text flowing into a header needs
> scrubbing.

---

## Part 2 — Config: two new env vars (`src/lib/config.ts`)

Remember the house rule (CLAUDE.md §4): *every external input crosses a Zod
boundary*. Environment variables are external input, so the two new ones get
validated in the same `EnvSchema` as `DATABASE_URL`.

```ts
NTFY_URL: z.string().url().optional(),

POLL_SCHEDULE_ENABLED: z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true"),
```

### 1.5d `NTFY_URL` is optional — but validated *if present*

`.url().optional()` means: you may leave it unset, **but if you set it, it must be
a real URL**. This is the sweet spot — a typo'd ntfy URL fails loudly at startup
instead of silently never delivering. "Optional" and "unvalidated" are not the
same thing, and Zod lets you have optional-but-validated.

### 1.5e The `POLL_SCHEDULE_ENABLED` footgun (the line most worth remembering)

Your instinct for a boolean env var is probably `z.coerce.boolean()`. **Don't.**
In JavaScript, *every non-empty string is truthy* — including the string
`"false"`. So `z.coerce.boolean()` turns `"false"` into `true`. You'd set
`POLL_SCHEDULE_ENABLED=false` to turn the scheduler off and it would turn *on*.
That is a genuinely nasty, hard-to-spot bug.

Instead we:
1. `z.enum(["true", "false"])` — the raw value must be *literally* the string
   `"true"` or `"false"` (anything else is a startup error),
2. `.default("false")` — unset means the string `"false"`,
3. `.transform((v) => v === "true")` — convert that string to a real boolean.

After this line, the rest of the code reads `env.POLL_SCHEDULE_ENABLED` as a clean
`true`/`false`. The parsing footgun is contained to this one place.

> Python analog: `bool("false")` in Python is *also* `True` for the same reason
> (non-empty string). This footgun is not JS-specific — you'd write the same
> explicit `== "true"` check in pydantic-settings.

---

## Part 3 — The scheduler plugin (`src/modules/poller/scheduler.ts`)

### 1.5f In-process cron vs the OS cron daemon — the real design decision

The plan could have said "add a line to the server's crontab". We deliberately
put the schedule *inside the Node process* instead. Trade-offs:

**In-process (what we chose):**
- The schedule ships with the code — clone the repo, run it, the cron exists. No
  separate server configuration to remember or document.
- It only fires while the API is running. If the process is down, no poll. For a
  home-LAN dashboard that's *fine* — if the API is down, there's nothing to poll
  *into* anyway.
- One process to reason about, one log stream.

**OS cron daemon (what we avoided):**
- Survives the app being down, but needs a separate script entry-point, separate
  env-var loading, and lives in server config outside the repo.
- Overkill for a single always-on container.

For a self-hosted, always-running container, in-process wins on simplicity. (If
we later ran *many* API replicas, an in-process cron would fire once *per
replica* — you'd then move to a single external scheduler or a leader-election
lock. node-cron v4 actually has a `distributed` option for exactly that. We don't
need it.)

### 1.5g Reading the plugin top to bottom

```ts
export async function schedulerPlugin(app: FastifyInstance): Promise<void> {
  if (!env.POLL_SCHEDULE_ENABLED) {
    app.log.info("poll scheduler disabled (POLL_SCHEDULE_ENABLED=false)");
    return;                                    // (A) opt-in guard
  }

  const task = cron.schedule(
    "0 8,14 * * *",
    async () => {
      try {                                    // (B) contain the throw
        const summary = await runPoll();
        app.log.info({ ...summary }, "scheduled poll: finished");
      } catch (err) {
        app.log.error(err, "scheduled poll: failed");
      }
    },
    { timezone: "America/New_York", name: "poll", noOverlap: true },  // (C)
  );

  app.addHook("onClose", async () => { await task.destroy(); });      // (D)
}
```

**(A) The opt-in guard.** If `POLL_SCHEDULE_ENABLED` is false, we log why and
return *before arming anything*. Why off by default? During development you run
`tsx watch`, which restarts the server every time you save a file. You do **not**
want each of those restarts to potentially fire a real poll against 68 live job
boards. Off-by-default means "nothing surprising happens on my laptop"; the
deployed container flips it on with one env var.

**(B) Contain the throw.** A cron callback has *no caller* — when 08:00 arrives,
node-cron invokes your function into the void. If that function throws and nothing
catches it, in Node that's an unhandled rejection that can crash the process. So
we wrap the body in `try/catch`: one bad poll logs an error and the *schedule
keeps running* for the next tick. Compare this to step 1.4's per-company
try/catch — same philosophy at a different layer: **isolate failures so one bad
run doesn't kill the whole system.**

**(C) The options object:**
- `timezone: "America/New_York"` — see vocabulary. Without this, "8" is 8am in
  the server's zone, probably UTC, probably the middle of your night.
- `name: "poll"` — a label that shows up in logs and node-cron's task registry.
  Purely for observability.
- `noOverlap: true` — if a poll is somehow still running when the next tick fires
  (a slow morning where boards are timing out), **skip** the new tick rather than
  run two `runPoll`s at once. `runPoll` is idempotent so a double-run wouldn't
  *corrupt* data, but it would double the load for no benefit. This is the
  cron-level equivalent of a "max one instance" lock.

**(D) Clean teardown.** `app.addHook("onClose", ...)` registers a shutdown
callback — Fastify runs it when the server stops. We `task.destroy()` to stop the
timer. Without this, a stopped server could leave a live interval behind; in tests
especially, a leaked timer keeps the Node process alive and hangs your test run.
Always tear down what you set up.

> Fastify lifecycle note: `onClose` is Fastify's version of a shutdown hook, the
> mirror image of a startup hook. Python analog: FastAPI's `lifespan` context
> manager, where the code after `yield` is your teardown.

### 1.5h Wiring it into the server

`server.ts` gains one line next to the route plugins:

```ts
app.register(schedulerPlugin);
```

To Fastify, a background-job plugin and a routes plugin look identical — both are
just "a function that sets things up on `app`". That uniformity is the whole point
of the plugin pattern: `server.ts` stays a boring list of `register` calls and
never grows step-specific logic.

---

## Part 4 — The notification the poll actually sends

Back in `run.ts`, after the audit row is written, we added:

```ts
if (candidates.length > 0) {
  const lines = candidates.slice(0, 5).map((c) => `${c.company} — ${c.title}`);
  if (candidates.length > 5) lines.push(`…and ${candidates.length - 5} more`);
  await notify({
    title: `${candidates.length} new job candidate${candidates.length === 1 ? "" : "s"}`,
    message: lines.join("\n"),
    priority: "default",
    tags: ["briefcase"],
    click: candidates.length === 1 ? candidates[0]?.url : undefined,
  });
}
```

Design choices worth noting:

- **Only notify on *new candidates*, not every run.** A poll that finds nothing
  new should be silent — otherwise you train yourself to ignore the notifications.
  A notification you always ignore is worse than no notification.
- **Preview the first 5, summarize the rest.** A push notification is a glance,
  not a report. Five lines plus "…and N more" respects that.
- **`click` only for a single hit.** If there's exactly one new job, tapping the
  notification jumps straight to it. A list of ten has no single URL to open, so
  we omit it (`undefined`). (The `?.` is because TypeScript's strict indexing
  can't *prove* `candidates[0]` exists just from `length === 1` — the `?.` is the
  cheap way to satisfy it.)
- **This call is `await`ed but its result is ignored.** Remember `notify` never
  throws and returns a boolean — we don't branch on it here. The poll's success
  does not depend on the buzz landing.

---

## Part 5 — How you verify it (the checkpoint)

The plan's checkpoint is "temporarily schedule every minute, watch it fire and
your phone buzz, then restore". Concretely:

1. Put a real topic in `.env`: `NTFY_URL=https://ntfy.sh/jobber-<something-random>`
   and subscribe to that exact topic in the ntfy phone app. (Pick something
   unguessable — anyone who knows the topic name can read your notifications.)
2. Temporarily set the cron to `"* * * * *"` (every minute) in `scheduler.ts` and
   `POLL_SCHEDULE_ENABLED=true` in `.env`.
3. Make sure Postgres is up (`docker compose up -d db`), then `pnpm --filter api dev`.
4. Within a minute the logs show `scheduled poll: starting` → `finished`, and if
   there are new candidates your phone buzzes.
5. **Restore** `"0 8,14 * * *"` and set `POLL_SCHEDULE_ENABLED=false` for normal dev.

No phone handy? Leave `NTFY_URL` unset — `notify()` no-ops — and just confirm the
`scheduled poll: starting/finished` log lines appear on the every-minute schedule.

---

## Interview-ready summary

If someone asks "how does the poller run automatically?", you can now say:

> A node-cron task registered as a Fastify plugin fires the (idempotent) poll at
> 08:00 and 14:00 New York time. It's opt-in via an env var so dev restarts don't
> hammer real boards, the cron callback is wrapped so one bad run can't crash the
> process or stop the schedule, and it tears its timer down on server close. When
> a run surfaces new candidate jobs it POSTs a summary to an ntfy topic for a
> phone push — a side effect deliberately built to never throw and to no-op when
> unconfigured, so it can't affect the poll itself.

That's the shape of good background-job code: **the schedule is idempotent, the
callback is crash-contained, and the notification is a fire-and-forget side
effect that can fail without consequence.**
