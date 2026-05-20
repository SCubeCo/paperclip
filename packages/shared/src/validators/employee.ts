import { z } from "zod";
import { HUMAN_COMPANY_MEMBERSHIP_ROLES } from "../constants.js";

export const employeeExperienceLevelSchema = z.enum(["junior", "mid", "senior", "lead"]);

export const employeeAvailabilityStatusSchema = z.enum([
  "invited",
  "pending_acceptance",
  "available",
  "busy",
  "away",
  "suspended",
]);

export const createEmployeeSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(320),
  workspaceRole: z.enum(HUMAN_COMPANY_MEMBERSHIP_ROLES),
  role: z.string().trim().min(1).max(120),
  department: z.string().trim().max(120).optional().nullable(),
  experienceLevel: employeeExperienceLevelSchema.optional().default("mid"),
  skills: z.array(z.string().trim().min(1).max(80)).max(20).optional().default([]),
  assignedProjects: z.array(z.string().trim().min(1).max(120)).max(20).optional().default([]),
  manager: z.union([
    z.object({
      type: z.literal("agent"),
      agentId: z.string().uuid(),
    }),
    z.object({
      type: z.literal("employee"),
      membershipId: z.string().uuid(),
    }),
  ]),
});

export type CreateEmployee = z.infer<typeof createEmployeeSchema>;