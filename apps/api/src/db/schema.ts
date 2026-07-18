import {
	boolean,
	integer,
	jsonb,
	numeric,
	pgTable,
	real,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// schema.ts — the database, described in TypeScript.
//
// This file IS the source of truth for the DB shape. `drizzle-kit generate`
// diffs this against the last migration and writes the SQL to bring the DB in
// line; you never hand-edit tables. Coming from Python, this is Alembic's
// autogenerate, but the "models" are plain typed objects instead of a class
// hierarchy, and the generated SQL is meant to be read (it's the lesson).
//
// Two Drizzle idioms used throughout:
//   • text("col", { enum: [...] }) — a plain TEXT column whose *TypeScript* type
//     is narrowed to the union. It is NOT a Postgres ENUM type, so adding a new
//     value later is a code change, not a schema migration. Deliberately simple.
//   • timestamp(..., { withTimezone: true }) — stores timestamptz. Always prefer
//     it over naive timestamps so "8am" is unambiguous across machines.
// ---------------------------------------------------------------------------

// --- companies: the ~50 employers we poll (build plan §3) -------------------
export const companies = pgTable("companies", {
	id: uuid("id").defaultRandom().primaryKey(),
	// UNIQUE so the seed is idempotent: re-running inserts with
	// onConflictDoNothing(target: name) skip rows that already exist instead of
	// duplicating them. The company name is our stable business key.
	name: text("name").notNull().unique(),
	atsType: text("ats_type", {
		enum: ["greenhouse", "lever", "ashby", "manual"],
	}).notNull(),
	atsToken: text("ats_token"), // null for "manual" companies (no pollable API)
	fitGroup: integer("fit_group"), // your Group 1–5 tiers
	notes: text("notes"),
	active: boolean("active").notNull().default(true),
});

// --- resume_versions: base resume + tailored variants -----------------------
// Defined before `applications` because an application references the exact
// resume that went out.
export const resumeVersions = pgTable("resume_versions", {
	id: uuid("id").defaultRandom().primaryKey(),
	label: text("label").notNull(),
	filePath: text("file_path"), // stored file on the data volume (Phase 3)
	extractedText: text("extracted_text").notNull(),
	active: boolean("active").notNull().default(false),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

// --- profile_versions: the versioned Ideal Job Profile (build plan §5.3) ----
export const profileVersions = pgTable("profile_versions", {
	id: uuid("id").defaultRandom().primaryKey(),
	version: integer("version").notNull().unique(), // human-facing v1, v2, …
	northStar: text("north_star").notNull(), // the prose statement
	rubric: jsonb("rubric").$type<{
		hardFilters: Record<string, unknown>;
		criteria: { name: string; weight: number; description: string }[];
	}>(), // the weighted grading key the scorer consumes
	active: boolean("active").notNull().default(false),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

// --- job_postings: one role, deduped by (company_id, external_id) -----------
export const jobPostings = pgTable(
	"job_postings",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		companyId: uuid("company_id")
			.notNull()
			.references(() => companies.id),
		externalId: text("external_id").notNull(), // the ATS's own id — dedupe key
		title: text("title").notNull(),
		location: text("location"),
		remote: boolean("remote"),
		compMin: integer("comp_min"),
		compMax: integer("comp_max"),
		description: text("description"),
		url: text("url").notNull(),
		source: text("source", {
			enum: ["poller", "manual", "hn", "rss"],
		})
			.notNull()
			.default("poller"),
		contentHash: text("content_hash").notNull(), // detect edited postings
		status: text("status", { enum: ["open", "closed"] })
			.notNull()
			.default("open"),
		firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	// The idempotency key: two runs of the poller can't create duplicate rows
	// for the same (company, external_id). This is what makes polling safe to
	// repeat — the whole upsert-on-conflict strategy (step 1.4) hangs off it.
	(t) => [uniqueIndex("job_dedupe").on(t.companyId, t.externalId)],
);

// --- fit_scores: one row per scoring run, so re-scores keep history ---------
export const fitScores = pgTable("fit_scores", {
	id: uuid("id").defaultRandom().primaryKey(),
	jobPostingId: uuid("job_posting_id")
		.notNull()
		.references(() => jobPostings.id),
	// Which profile version graded this posting — nullable until Phase 3 builds
	// the profile; a null score simply means "graded against the resume alone".
	profileVersionId: uuid("profile_version_id").references(
		() => profileVersions.id,
	),
	score: real("score").notNull(), // 0–10, decimals allowed (e.g. 9.1)
	matchPoints: jsonb("match_points").$type<string[]>().notNull(),
	gaps: jsonb("gaps").$type<string[]>().notNull(),
	credentialGapFlag: boolean("credential_gap_flag").notNull().default(false),
	rationale: text("rationale").notNull(),
	modelUsed: text("model_used").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

// --- applications: your pipeline (the xlsx, upgraded) -----------------------
export const applications = pgTable("applications", {
	id: uuid("id").defaultRandom().primaryKey(),
	// Nullable: you apply to things the poller never saw. When set, links the
	// application back to the posting (and through it, the score).
	jobPostingId: uuid("job_posting_id").references(() => jobPostings.id),
	companyId: uuid("company_id").references(() => companies.id),
	// Snapshot fields — captured at apply time so the row is self-describing even
	// for off-poller applications with no company/posting rows.
	companyName: text("company_name").notNull(),
	roleTitle: text("role_title").notNull(),
	channel: text("channel", {
		enum: ["ats", "careers_email", "hn", "wellfound", "referral"],
	}).notNull(),
	appliedAt: timestamp("applied_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	// Denormalized current status — a convenience mirror of the event log below.
	// The events are the truth; this column is what the UI reads fast.
	status: text("status", {
		enum: ["applied", "screen", "interview", "offer", "rejected", "ghosted"],
	})
		.notNull()
		.default("applied"),
	resumeVersionId: uuid("resume_version_id").references(
		() => resumeVersions.id,
	),
	notes: text("notes"),
});

// --- application_events: append-only log; status is derived from it ----------
export const applicationEvents = pgTable("application_events", {
	id: uuid("id").defaultRandom().primaryKey(),
	applicationId: uuid("application_id")
		.notNull()
		.references(() => applications.id),
	type: text("type", {
		enum: ["applied", "auto_ack", "rejection", "screen_invite", "note"],
	}).notNull(),
	occurredAt: timestamp("occurred_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	detail: text("detail"),
});

// --- poll_runs: one row per poller execution (ops/observability) ------------
// Feeds the Companies page (which boards are ok / failing) and is the audit
// trail proving the scheduler ran. Written once at the end of each runPoll().
export const pollRuns = pgTable("poll_runs", {
	id: uuid("id").defaultRandom().primaryKey(),
	startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
	companiesOk: integer("companies_ok").notNull(),
	companiesFailed: integer("companies_failed").notNull(),
	newCount: integer("new_count").notNull(), // postings first seen this run
	candidateCount: integer("candidate_count").notNull(), // new ones passing prefilter
	// Which boards failed and why — so the UI can show "failing" per company.
	failures: jsonb("failures")
		.$type<{ company: string; reason: string }[]>()
		.notNull()
		.default([]),
});

// --- ai_runs: the cost/audit ledger (build plan §3; interview gold) ---------
export const aiRuns = pgTable("ai_runs", {
	id: uuid("id").defaultRandom().primaryKey(),
	feature: text("feature", {
		enum: ["score", "resume_review", "profile"],
	}).notNull(),
	provider: text("provider").notNull(), // api | cli | cowork
	model: text("model").notNull(),
	inputTokens: integer("input_tokens").notNull(),
	outputTokens: integer("output_tokens").notNull(),
	// numeric keeps money exact; note Drizzle returns it as a *string* on read,
	// which we'll parse where we sum it (avoids float rounding on cents).
	estCost: numeric("est_cost", { precision: 10, scale: 6 }),
	durationMs: integer("duration_ms").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});
