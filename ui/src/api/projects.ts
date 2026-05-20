import type {
  Project,
  ProjectWorkspace,
  WorkspaceOperation,
  WorkspaceRuntimeControlTarget,
} from "@paperclipai/shared";
import { api } from "./client";
import { sanitizeWorkspaceRuntimeControlTarget } from "./workspace-runtime-control";

function withCompanyScope(path: string, companyId?: string) {
  if (!companyId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}companyId=${encodeURIComponent(companyId)}`;
}

function projectPath(id: string, companyId?: string, suffix = "") {
  return withCompanyScope(`/projects/${encodeURIComponent(id)}${suffix}`, companyId);
}

export const projectsApi = {
  list: (companyId: string) => api.get<Project[]>(`/companies/${companyId}/projects`),
  get: (id: string, companyId?: string) => api.get<Project>(projectPath(id, companyId)),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Project>(`/companies/${companyId}/projects`, data),
  update: (id: string, data: Record<string, unknown>, companyId?: string) =>
    api.patch<Project>(projectPath(id, companyId), data),
  listWorkspaces: (projectId: string, companyId?: string) =>
    api.get<ProjectWorkspace[]>(projectPath(projectId, companyId, "/workspaces")),
  createWorkspace: (projectId: string, data: Record<string, unknown>, companyId?: string) =>
    api.post<ProjectWorkspace>(projectPath(projectId, companyId, "/workspaces"), data),
  updateWorkspace: (projectId: string, workspaceId: string, data: Record<string, unknown>, companyId?: string) =>
    api.patch<ProjectWorkspace>(
      projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}`),
      data,
    ),
  controlWorkspaceRuntimeServices: (
    projectId: string,
    workspaceId: string,
    action: "start" | "stop" | "restart",
    companyId?: string,
    target: WorkspaceRuntimeControlTarget = {},
  ) =>
    api.post<{ workspace: ProjectWorkspace; operation: WorkspaceOperation }>(
      projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}/runtime-services/${action}`),
      sanitizeWorkspaceRuntimeControlTarget(target),
    ),
  controlWorkspaceCommands: (
    projectId: string,
    workspaceId: string,
    action: "start" | "stop" | "restart" | "run",
    companyId?: string,
    target: WorkspaceRuntimeControlTarget = {},
  ) =>
    api.post<{ workspace: ProjectWorkspace; operation: WorkspaceOperation }>(
      projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}/runtime-commands/${action}`),
      sanitizeWorkspaceRuntimeControlTarget(target),
    ),
  removeWorkspace: (projectId: string, workspaceId: string, companyId?: string) =>
    api.delete<ProjectWorkspace>(projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}`)),
  remove: (id: string, companyId?: string) => api.delete<Project>(projectPath(id, companyId)),
  generateRequirementAnalysis: (
    id: string,
    payload: { agentType: "requirement-breakdown" | "sow"; requirements: string },
    companyId?: string,
  ) =>
    api.post<{ output: string }>(projectPath(id, companyId, "/requirement-analysis/generate"), payload),
  saveRequirementAnalysis: (
    id: string,
    payload: { agentType: "requirement-breakdown" | "sow"; title: string; content: string },
    companyId?: string,
  ) =>
    api.post<{
      id: string;
      companyId: string;
      projectId: string;
      agentType: string;
      title: string;
      content: string;
      createdAt: string;
      updatedAt: string;
    }>(projectPath(id, companyId, "/requirement-analysis/save"), payload),
  shareRequirementAnalysisWithShovan: (
    id: string,
    payload: { agentType: "requirement-breakdown" | "sow"; title: string; content: string },
    companyId?: string,
  ) =>
    api.post<{
      id: string;
      status: "pending";
      shovanEmail: string;
      createdAt: string;
    }>(projectPath(id, companyId, "/requirement-analysis/share-with-shovan"), payload),
  getShareApprovalStatus: (
    projectId: string,
    shareId: string,
    companyId?: string,
  ) =>
    api.get<{
      id: string;
      status: "pending" | "approved" | "rejected" | "failed" | "client_shared";
      shovanEmail: string;
      managerEmail?: string;
      clientEmail?: string[];
      createdAt: string;
      approvedAt?: string;
    }>(projectPath(projectId, companyId, `/requirement-analysis/share-status/${encodeURIComponent(shareId)}`)),
  shareRequirementAnalysisWithClient: (
    projectId: string,
    payload: { shareId: string },
    companyId?: string,
  ) =>
    api.post<{
      id: string;
      status: "client_shared";
      clientEmail?: string[];
      updatedAt: string;
    }>(projectPath(projectId, companyId, "/requirement-analysis/share-with-client"), payload),
  getLatestRequirementAnalysisShare: (
    projectId: string,
    agentType?: "requirement-breakdown" | "sow",
    companyId?: string,
  ) =>
    api.get<{
      id: string;
      status: "pending" | "approved" | "rejected" | "failed" | "client_shared";
      shovanEmail: string;
      managerEmail?: string;
      clientEmail?: string[];
      createdAt: string;
      approvedAt?: string;
      rejectedAt?: string;
    } | null>(
      projectPath(
        projectId,
        companyId,
        `/requirement-analysis/latest-share${
          agentType ? `?agentType=${encodeURIComponent(agentType)}` : ""
        }`,
      ),
    ),
  listSavedRequirementAnalyses: (id: string, companyId?: string) =>
    api.get<Array<{
      id: string;
      companyId: string;
      projectId: string;
      agentType: string;
      title: string;
      content: string;
      createdAt: string;
      updatedAt: string;
    }>>(projectPath(id, companyId, "/requirement-analysis/saved")),
};
