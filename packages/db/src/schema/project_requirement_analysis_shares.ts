import { pgTable, uuid, text, timestamp, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { projectRequirementAnalyses } from "./project_requirement_analyses.js";

export const projectRequirementAnalysisShares = pgTable(
  "project_requirement_analysis_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    analysisId: uuid("analysis_id").references(() => projectRequirementAnalyses.id, { onDelete: "set null" }),
    agentType: text("agent_type").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    shovanEmail: text("shovan_email").notNull(),
    managerEmail: text("manager_email"),
    clientEmail: jsonb("client_email").$type<string[]>(),
    status: text("status").notNull().default("pending"),
    approvalToken: text("approval_token").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectStatusIdx: index("project_req_analysis_shares_company_project_status_idx").on(
      table.companyId,
      table.projectId,
      table.status,
    ),
    approvalTokenUq: uniqueIndex("project_req_analysis_shares_approval_token_uq").on(table.approvalToken),
  }),
);