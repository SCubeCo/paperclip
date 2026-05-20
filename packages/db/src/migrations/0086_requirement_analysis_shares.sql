CREATE TABLE IF NOT EXISTS "project_requirement_analysis_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"analysis_id" uuid,
	"agent_type" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"shovan_email" text NOT NULL,
	"manager_email" text,
	"client_email" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"approval_token" text NOT NULL,
	"approved_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_requirement_analysis_shares_company_id_companies_id_fk') THEN
		ALTER TABLE "project_requirement_analysis_shares" ADD CONSTRAINT "project_requirement_analysis_shares_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_requirement_analysis_shares_project_id_projects_id_fk') THEN
		ALTER TABLE "project_requirement_analysis_shares" ADD CONSTRAINT "project_requirement_analysis_shares_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_requirement_analysis_shares_analysis_id_project_requirement_analyses_id_fk') THEN
		ALTER TABLE "project_requirement_analysis_shares" ADD CONSTRAINT "project_requirement_analysis_shares_analysis_id_project_requirement_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."project_requirement_analyses"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_req_analysis_shares_company_project_status_idx" ON "project_requirement_analysis_shares" USING btree ("company_id","project_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_req_analysis_shares_approval_token_uq" ON "project_requirement_analysis_shares" USING btree ("approval_token");