DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'manager_email') THEN
		ALTER TABLE "projects" ADD COLUMN "manager_email" text;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'client_email') THEN
		ALTER TABLE "projects" ADD COLUMN "client_email" text;
	END IF;
END $$;