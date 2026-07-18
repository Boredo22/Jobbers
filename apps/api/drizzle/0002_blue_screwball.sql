CREATE TABLE "poll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"companies_ok" integer NOT NULL,
	"companies_failed" integer NOT NULL,
	"new_count" integer NOT NULL,
	"candidate_count" integer NOT NULL,
	"failures" jsonb DEFAULT '[]'::jsonb NOT NULL
);
