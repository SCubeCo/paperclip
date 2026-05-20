import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { companyMemberships } from "./company_memberships.js";

export const employeeAiAgentLinks = pgTable(
  "employee_ai_agent_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => companyMemberships.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    relationType: text("relation_type").notNull().default("assistant"),
    isPrimary: boolean("is_primary").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    membershipAgentUniqueIdx: uniqueIndex("employee_ai_links_membership_agent_unique_idx").on(
      table.companyId,
      table.membershipId,
      table.agentId,
    ),
    companyMembershipIdx: index("employee_ai_links_company_membership_idx").on(
      table.companyId,
      table.membershipId,
    ),
    companyAgentIdx: index("employee_ai_links_company_agent_idx").on(table.companyId, table.agentId),
  }),
);