import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companyMemberships } from "./company_memberships.js";

export const employeeProfiles = pgTable(
  "employee_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => companyMemberships.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    email: text("email"),
    role: text("role").notNull(),
    experienceLevel: text("experience_level").notNull().default("mid"),
    department: text("department"),
    availabilityStatus: text("availability_status").notNull().default("available"),
    skills: jsonb("skills").$type<string[]>().notNull().default([]),
    assignedProjects: jsonb("assigned_projects").$type<string[]>().notNull().default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyMembershipUniqueIdx: uniqueIndex("employee_profiles_company_membership_unique_idx").on(
      table.companyId,
      table.membershipId,
    ),
    companyAvailabilityIdx: index("employee_profiles_company_availability_idx").on(
      table.companyId,
      table.availabilityStatus,
    ),
  }),
);