-- Migrate client_email from text to jsonb in projects
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'client_email' AND data_type = 'text') THEN
    ALTER TABLE "projects" DROP COLUMN "client_email";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'client_email') THEN
    ALTER TABLE "projects" ADD COLUMN "client_email" jsonb;
  END IF;
END $$;
--> statement-breakpoint
-- Migrate client_email from text to jsonb in project_requirement_analysis_shares
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'project_requirement_analysis_shares' AND column_name = 'client_email' AND data_type = 'text') THEN
    ALTER TABLE "project_requirement_analysis_shares" DROP COLUMN "client_email";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'project_requirement_analysis_shares' AND column_name = 'client_email') THEN
    ALTER TABLE "project_requirement_analysis_shares" ADD COLUMN "client_email" jsonb;
  END IF;
END $$;
