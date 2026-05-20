import type { HumanCompanyMembershipRole, MembershipStatus } from "../constants.js";

export type EmployeeExperienceLevel = "junior" | "mid" | "senior" | "lead";
export type EmployeeAvailabilityStatus =
  | "invited"
  | "pending_acceptance"
  | "available"
  | "busy"
  | "away"
  | "suspended";
export type EmployeeManagerType = "agent" | "employee";
export type EmployeeWorkforceStatus = "invited" | "pending_acceptance" | "active" | "suspended";

export interface EmployeeManagerRef {
  type: EmployeeManagerType;
  membershipId?: string;
  agentId?: string;
  displayName: string | null;
}

export interface EmployeeInvitationSummary {
  inviteId: string | null;
  invitePath: string | null;
  inviteUrl: string | null;
  onboardingTextUrl: string | null;
  emailStatus: "sent" | "skipped" | "failed";
  emailError: string | null;
  sentAt: Date | null;
  acceptedAt: Date | null;
}

export interface EmployeePersonalAgentSummary {
  id: string;
  name: string;
  role: string;
  status: string | null;
  reportsTo: string | null;
}

export interface EmployeeRecord {
  id: string;
  companyId: string;
  membershipId: string;
  membershipStatus: MembershipStatus;
  workforceStatus: EmployeeWorkforceStatus;
  workspaceRole: HumanCompanyMembershipRole | null;
  displayName: string;
  email: string;
  role: string;
  department: string | null;
  experienceLevel: EmployeeExperienceLevel;
  availabilityStatus: EmployeeAvailabilityStatus;
  skills: string[];
  assignedProjects: string[];
  manager: EmployeeManagerRef | null;
  invitation: EmployeeInvitationSummary | null;
  personalAgent: EmployeePersonalAgentSummary | null;
  memberUser: {
    id: string | null;
    email: string | null;
    name: string | null;
    image: string | null;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EmployeesListResponse {
  employees: EmployeeRecord[];
  access: {
    canCreateEmployees: boolean;
    canInviteUsers: boolean;
    canManageMembers: boolean;
  };
}

export interface CreateEmployeeInput {
  displayName: string;
  email: string;
  workspaceRole: HumanCompanyMembershipRole;
  role: string;
  department?: string | null;
  experienceLevel?: EmployeeExperienceLevel;
  skills?: string[];
  assignedProjects?: string[];
  manager:
    | {
        type: "agent";
        agentId: string;
      }
    | {
        type: "employee";
        membershipId: string;
      };
}

export interface CreateEmployeeResponse {
  employee: EmployeeRecord;
}