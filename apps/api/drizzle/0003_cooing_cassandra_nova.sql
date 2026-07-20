CREATE TABLE "scoring_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_posting_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scoring_queue_job_posting_id_unique" UNIQUE("job_posting_id")
);
--> statement-breakpoint
ALTER TABLE "fit_scores" ADD COLUMN "prompt_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "fit_scores" ADD COLUMN "feedback" text;--> statement-breakpoint
ALTER TABLE "fit_scores" ADD COLUMN "feedback_note" text;--> statement-breakpoint
ALTER TABLE "scoring_queue" ADD CONSTRAINT "scoring_queue_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE no action ON UPDATE no action;