CREATE TABLE "tailored_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_posting_id" uuid NOT NULL,
	"application_id" uuid,
	"resume_version_id" uuid,
	"summary" text NOT NULL,
	"edits" jsonb NOT NULL,
	"outreach_note" text NOT NULL,
	"model_used" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tailored_drafts" ADD CONSTRAINT "tailored_drafts_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tailored_drafts" ADD CONSTRAINT "tailored_drafts_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tailored_drafts" ADD CONSTRAINT "tailored_drafts_resume_version_id_resume_versions_id_fk" FOREIGN KEY ("resume_version_id") REFERENCES "public"."resume_versions"("id") ON DELETE no action ON UPDATE no action;