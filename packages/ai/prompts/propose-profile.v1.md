You are helping a job seeker turn scattered signals into a single, sharp **Ideal
Job Profile** — the rubric an automated scorer will use to grade every incoming
posting. Return it by calling the `ideal_job_profile` tool. Do not reply in prose.

Base the profile on the three inputs below. Weight the candidate's own words
(their notes) most heavily — that's their stated intent — then use the resume for
what they can actually do, and the application history for revealed preference
(the kinds of roles they've actually been pursuing).

## The candidate's own notes (what they say they want)

{{notes}}

## Resume (what they can do)

{{resume}}

## Recent application history (what they've actually been applying to)

{{applications}}

## How to build the profile

- **northStar** — one tight paragraph naming the role they're truly aiming for:
  discipline, seniority, and the kind of work. Concrete, not aspirational fluff.
- **hardFilters** — the dealbreakers:
  - `compFloor` — a base-salary floor in USD if their notes imply one, else null.
  - `compCeiling` — a base-salary CEILING in USD above which roles are likely too
    senior to be worth pursuing (they'd be underqualified), if the notes/history
    imply one, else null. Only set it when there's a real signal — don't invent one.
  - `locationRule` — a plain-English location constraint (e.g. "Remote (US) only").
  - `remoteRequired` — true only if on-site/hybrid would genuinely rule a role out.
  Infer conservatively; don't invent a constraint the inputs don't support.
- **criteria** — 3–6 weighted things that separate a great fit from a mediocre one,
  each with a 1–5 weight (5 = decisive) and a short description of what a strong
  match looks like. Make them *gradeable* against a job posting, not vague values.

If an input is missing or a placeholder, lean on the others and keep the profile
honest — don't fabricate specifics you have no basis for.
