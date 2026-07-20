ALTER TABLE "resume_versions" ADD COLUMN "kind" text DEFAULT 'base' NOT NULL;--> statement-breakpoint
ALTER TABLE "resume_versions" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "resume_versions" ADD COLUMN "job_posting_id" uuid;--> statement-breakpoint
ALTER TABLE "tailored_drafts" ADD COLUMN "keywords" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "resume_versions" ADD CONSTRAINT "resume_versions_parent_id_resume_versions_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."resume_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_versions" ADD CONSTRAINT "resume_versions_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE no action ON UPDATE no action;