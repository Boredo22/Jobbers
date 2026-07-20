CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"resume_version_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "fit_scores" ADD COLUMN "profile_id" uuid;--> statement-breakpoint
ALTER TABLE "profile_versions" ADD COLUMN "profile_id" uuid;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_resume_version_id_resume_versions_id_fk" FOREIGN KEY ("resume_version_id") REFERENCES "public"."resume_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fit_scores" ADD CONSTRAINT "fit_scores_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_versions" ADD CONSTRAINT "profile_versions_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;