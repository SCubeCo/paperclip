import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { and, eq, ne, desc as descOrd } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, projectRequirementAnalyses, projectRequirementAnalysisShares, workspaceOperations } from "@paperclipai/db";
import {
  createProjectSchema,
  createProjectWorkspaceSchema,
  findWorkspaceCommandDefinition,
  isUuidLike,
  matchWorkspaceRuntimeServiceToCommand,
  updateProjectSchema,
  updateProjectWorkspaceSchema,
  workspaceRuntimeControlTargetSchema,
} from "@paperclipai/shared";
import type { WorkspaceRuntimeDesiredState, WorkspaceRuntimeServiceStateMap } from "@paperclipai/shared";
import { trackProjectCreated } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import { projectService, logActivity, workspaceOperationService, issueService, heartbeatService } from "../services/index.js";
import { conflict, forbidden } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  buildWorkspaceRuntimeDesiredStatePatch,
  listConfiguredRuntimeServiceEntries,
  runWorkspaceJobForControl,
  startRuntimeServicesForWorkspaceControl,
  stopRuntimeServicesForProjectWorkspace,
} from "../services/workspace-runtime.js";
import {
  assertNoAgentHostWorkspaceCommandMutation,
  collectProjectExecutionWorkspaceCommandPaths,
  collectProjectWorkspaceCommandPaths,
} from "./workspace-command-authz.js";
import { assertCanManageProjectWorkspaceRuntimeServices } from "./workspace-runtime-service-authz.js";
import { getTelemetryClient } from "../telemetry.js";
import { appendWithCap } from "../adapters/utils.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";
import { environmentService } from "../services/environments.js";
import { secretService } from "../services/secrets.js";

const WORKSPACE_CONTROL_OUTPUT_MAX_CHARS = 256 * 1024;
const SHARED_WORKSPACE_STOP_AND_RESTART_ACTIONS = new Set(["stop", "restart"]);

type RequirementAnalysisLeadCandidate = Pick<
  typeof agents.$inferSelect,
  "id" | "role" | "status" | "createdAt"
>;

export function pickRequirementAnalysisLeadAgent(
  candidates: RequirementAnalysisLeadCandidate[],
): RequirementAnalysisLeadCandidate | undefined {
  const active = candidates.filter((candidate) => candidate.status !== "terminated");
  if (active.length === 0) return undefined;

  const sorted = [...active].sort((a, b) => {
    const roleRankA = a.role === "ceo" ? 0 : 1;
    const roleRankB = b.role === "ceo" ? 0 : 1;
    if (roleRankA !== roleRankB) return roleRankA - roleRankB;

    const createdA = a.createdAt instanceof Date ? a.createdAt.getTime() : 0;
    const createdB = b.createdAt instanceof Date ? b.createdAt.getTime() : 0;
    if (createdA !== createdB) return createdA - createdB;

    return a.id.localeCompare(b.id);
  });

  return sorted[0];
}

type GraphMailConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  senderUserId: string;
};

function readGraphMailConfig(): GraphMailConfig | null {
  const tenantId = process.env.MS_GRAPH_TENANT_ID?.trim() ?? "";
  const clientId = process.env.MS_GRAPH_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.MS_GRAPH_CLIENT_SECRET?.trim() ?? "";
  const senderUserId = process.env.MS_GRAPH_SENDER_USER_ID?.trim() ?? "";
  if (!tenantId || !clientId || !clientSecret || !senderUserId) {
    return null;
  }
  return { tenantId, clientId, clientSecret, senderUserId };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function getGraphAccessToken(config: GraphMailConfig): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });
  const response = await fetch(`https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Graph token request failed (${response.status}): ${detail}`);
  }
  const tokenPayload = (await response.json()) as { access_token?: string };
  if (!tokenPayload.access_token) {
    throw new Error("Graph token request succeeded but no access token was returned");
  }
  return tokenPayload.access_token;
}

async function sendGraphMail(
  config: GraphMailConfig,
  options: {
    to: string;
    subject: string;
    html: string;
    wordAttachmentName?: string;
    wordAttachmentContent?: string;
  },
) {
  const accessToken = await getGraphAccessToken(config);
  const wordAttachmentHtml =
    options.wordAttachmentName && options.wordAttachmentContent
      ? [
          "<html><head><meta charset=\"utf-8\"></head><body>",
          `<pre style=\"font-family:Calibri,Arial,sans-serif;font-size:11pt;white-space:pre-wrap;\">${escapeHtml(options.wordAttachmentContent)}</pre>`,
          "</body></html>",
        ].join("")
      : null;
  const attachments =
    options.wordAttachmentName && wordAttachmentHtml
      ? [
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: options.wordAttachmentName,
            contentType: "application/msword",
            contentBytes: Buffer.from(wordAttachmentHtml, "utf8").toString("base64"),
          },
        ]
      : [];

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.senderUserId)}/sendMail`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        message: {
          subject: options.subject,
          body: {
            contentType: "HTML",
            content: options.html,
          },
          toRecipients: [{ emailAddress: { address: options.to } }],
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        saveToSentItems: false,
      }),
    },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Graph sendMail failed (${response.status}): ${detail}`);
  }
}

export function projectRoutes(db: Db) {
  const router = Router();
  const svc = projectService(db);
  const secretsSvc = secretService(db);
  const environmentsSvc = environmentService(db);
  const heartbeat = heartbeatService(db);
  const issueSvc = issueService(db);

  async function assertProjectEnvironmentSelection(companyId: string, environmentId: string | null | undefined) {
    if (environmentId === undefined || environmentId === null) return;
    await assertEnvironmentSelectionForCompany(environmentsSvc, companyId, environmentId, {
      allowedDrivers: ["local", "ssh", "sandbox"],
    });
  }

  function readProjectPolicyEnvironmentId(policy: unknown): string | null | undefined {
    if (!policy || typeof policy !== "object" || !("environmentId" in policy)) {
      return undefined;
    }
    const environmentId = (policy as { environmentId?: unknown }).environmentId;
    return typeof environmentId === "string" || environmentId === null ? environmentId : undefined;
  }

  async function resolveCompanyIdForProjectReference(req: Request) {
    const companyIdQuery = req.query.companyId;
    const requestedCompanyId =
      typeof companyIdQuery === "string" && companyIdQuery.trim().length > 0
        ? companyIdQuery.trim()
        : null;
    if (requestedCompanyId) {
      assertCompanyAccess(req, requestedCompanyId);
      return requestedCompanyId;
    }
    if (req.actor.type === "agent" && req.actor.companyId) {
      return req.actor.companyId;
    }
    return null;
  }

  async function normalizeProjectReference(req: Request, rawId: string) {
    if (isUuidLike(rawId)) return rawId;
    const companyId = await resolveCompanyIdForProjectReference(req);
    if (!companyId) return rawId;
    const resolved = await svc.resolveByReference(companyId, rawId);
    if (resolved.ambiguous) {
      throw conflict("Project shortname is ambiguous in this company. Use the project ID.");
    }
    return resolved.project?.id ?? rawId;
  }

  router.param("id", async (req, _res, next, rawId) => {
    try {
      req.params.id = await normalizeProjectReference(req, rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/projects", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId);
    res.json(result);
  });

  router.get("/projects/:id", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);
    res.json(project);
  });

  router.post("/companies/:companyId/projects", validate(createProjectSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    type CreateProjectPayload = Parameters<typeof svc.create>[1] & {
      workspace?: Parameters<typeof svc.createWorkspace>[1];
    };

    const { workspace, ...projectData } = req.body as CreateProjectPayload;
    await assertProjectEnvironmentSelection(
      companyId,
      readProjectPolicyEnvironmentId(projectData.executionWorkspacePolicy),
    );
    assertNoAgentHostWorkspaceCommandMutation(
      req,
      [
        ...collectProjectExecutionWorkspaceCommandPaths(projectData.executionWorkspacePolicy),
        ...collectProjectWorkspaceCommandPaths(workspace, "workspace"),
      ],
    );
    if (projectData.env !== undefined) {
      projectData.env = await secretsSvc.normalizeEnvBindingsForPersistence(
        companyId,
        projectData.env,
        { strictMode: true, fieldPath: "env" },
      );
    }
    const project = await svc.create(companyId, projectData);
    if (project.env) {
      await secretsSvc.syncEnvBindingsForTarget?.(
        companyId,
        { targetType: "project", targetId: project.id },
        project.env,
      );
    }
    let createdWorkspaceId: string | null = null;
    if (workspace) {
      const createdWorkspace = await svc.createWorkspace(project.id, workspace);
      if (!createdWorkspace) {
        await svc.remove(project.id);
        res.status(422).json({ error: "Invalid project workspace payload" });
        return;
      }
      createdWorkspaceId = createdWorkspace.id;
    }
    const hydratedProject = workspace ? await svc.getById(project.id) : project;

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.created",
      entityType: "project",
      entityId: project.id,
      details: {
        name: project.name,
        workspaceId: createdWorkspaceId,
        envKeys: project.env ? Object.keys(project.env).sort() : [],
      },
    });
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackProjectCreated(telemetryClient);
    }
    res.status(201).json(hydratedProject ?? project);
  });

  router.patch("/projects/:id", validate(updateProjectSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const body = { ...req.body };
    assertNoAgentHostWorkspaceCommandMutation(
      req,
      collectProjectExecutionWorkspaceCommandPaths(body.executionWorkspacePolicy),
    );
    await assertProjectEnvironmentSelection(
      existing.companyId,
      readProjectPolicyEnvironmentId(body.executionWorkspacePolicy),
    );
    if (typeof body.archivedAt === "string") {
      body.archivedAt = new Date(body.archivedAt);
    }
    if (body.env !== undefined) {
      body.env = await secretsSvc.normalizeEnvBindingsForPersistence(existing.companyId, body.env, {
        strictMode: true,
        fieldPath: "env",
      });
    }
    const project = await svc.update(id, body);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (body.env !== undefined) {
      await secretsSvc.syncEnvBindingsForTarget?.(
        project.companyId,
        { targetType: "project", targetId: project.id },
        project.env,
      );
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.updated",
      entityType: "project",
      entityId: project.id,
      details: {
        changedKeys: Object.keys(req.body).sort(),
        envKeys:
          body.env && typeof body.env === "object" && !Array.isArray(body.env)
            ? Object.keys(body.env as Record<string, unknown>).sort()
            : undefined,
      },
    });

    res.json(project);
  });

  router.get("/projects/:id/workspaces", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const workspaces = await svc.listWorkspaces(id);
    res.json(workspaces);
  });

  router.post("/projects/:id/workspaces", validate(createProjectWorkspaceSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    assertNoAgentHostWorkspaceCommandMutation(
      req,
      collectProjectWorkspaceCommandPaths(req.body),
    );
    const workspace = await svc.createWorkspace(id, req.body);
    if (!workspace) {
      res.status(422).json({ error: "Invalid project workspace payload" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.workspace_created",
      entityType: "project",
      entityId: id,
      details: {
        workspaceId: workspace.id,
        name: workspace.name,
        cwd: workspace.cwd,
        isPrimary: workspace.isPrimary,
      },
    });

    res.status(201).json(workspace);
  });

  router.patch(
    "/projects/:id/workspaces/:workspaceId",
    validate(updateProjectWorkspaceSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const workspaceId = req.params.workspaceId as string;
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);
      assertNoAgentHostWorkspaceCommandMutation(
        req,
        collectProjectWorkspaceCommandPaths(req.body),
      );
      const workspaceExists = (await svc.listWorkspaces(id)).some((workspace) => workspace.id === workspaceId);
      if (!workspaceExists) {
        res.status(404).json({ error: "Project workspace not found" });
        return;
      }
      const workspace = await svc.updateWorkspace(id, workspaceId, req.body);
      if (!workspace) {
        res.status(422).json({ error: "Invalid project workspace payload" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "project.workspace_updated",
        entityType: "project",
        entityId: id,
        details: {
          workspaceId: workspace.id,
          changedKeys: Object.keys(req.body).sort(),
        },
      });

      res.json(workspace);
    },
  );

  async function handleProjectWorkspaceRuntimeCommand(req: Request, res: Response) {
    const id = req.params.id as string;
    const workspaceId = req.params.workspaceId as string;
    const action = String(req.params.action ?? "").trim().toLowerCase();
    if (action !== "start" && action !== "stop" && action !== "restart" && action !== "run") {
      res.status(404).json({ error: "Workspace command action not found" });
      return;
    }

    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);

    const workspace = project.workspaces.find((entry) => entry.id === workspaceId) ?? null;
    if (!workspace) {
      res.status(404).json({ error: "Project workspace not found" });
      return;
    }

    const isSharedWorkspace = Boolean(workspace.sharedWorkspaceKey);
    if (
      req.actor.type === "agent"
      && isSharedWorkspace
      && SHARED_WORKSPACE_STOP_AND_RESTART_ACTIONS.has(action)
    ) {
      throw forbidden("Missing permission to manage workspace runtime services");
    }

    await assertCanManageProjectWorkspaceRuntimeServices(db, req, {
      companyId: project.companyId,
      projectWorkspaceId: workspace.id,
    });

    const workspaceCwd = workspace.cwd;
    if (!workspaceCwd) {
      res.status(422).json({ error: "Project workspace needs a local path before Paperclip can run workspace commands" });
      return;
    }

    const runtimeConfig = workspace.runtimeConfig?.workspaceRuntime ?? null;
    const target = req.body as { workspaceCommandId?: string | null; runtimeServiceId?: string | null; serviceIndex?: number | null };
    const configuredServices = runtimeConfig ? listConfiguredRuntimeServiceEntries({ workspaceRuntime: runtimeConfig }) : [];
    const workspaceCommand = runtimeConfig
      ? findWorkspaceCommandDefinition(runtimeConfig, target.workspaceCommandId ?? null)
      : null;
    if (target.workspaceCommandId && !workspaceCommand) {
      res.status(404).json({ error: "Workspace command not found for this project workspace" });
      return;
    }
    if (target.runtimeServiceId && !(workspace.runtimeServices ?? []).some((service) => service.id === target.runtimeServiceId)) {
      res.status(404).json({ error: "Runtime service not found for this project workspace" });
      return;
    }
    const matchedRuntimeService =
      workspaceCommand?.kind === "service" && !target.runtimeServiceId
        ? matchWorkspaceRuntimeServiceToCommand(workspaceCommand, workspace.runtimeServices ?? [])
        : null;
    const selectedRuntimeServiceId = target.runtimeServiceId ?? matchedRuntimeService?.id ?? null;
    const selectedServiceIndex =
      workspaceCommand?.kind === "service"
        ? workspaceCommand.serviceIndex
        : target.serviceIndex ?? null;
    if (
      selectedServiceIndex !== undefined
      && selectedServiceIndex !== null
      && (selectedServiceIndex < 0 || selectedServiceIndex >= configuredServices.length)
    ) {
      res.status(422).json({ error: "Selected runtime service is not defined in this project workspace runtime config" });
      return;
    }
    if (workspaceCommand?.kind === "job" && action !== "run") {
      res.status(422).json({ error: `Workspace job "${workspaceCommand.name}" can only be run` });
      return;
    }
    if (workspaceCommand?.kind === "service" && action === "run") {
      res.status(422).json({ error: `Workspace service "${workspaceCommand.name}" should be started or restarted, not run` });
      return;
    }
    if (action === "run" && !workspaceCommand) {
      res.status(422).json({ error: "Select a workspace job to run" });
      return;
    }
    if ((action === "start" || action === "restart") && !runtimeConfig) {
      res.status(422).json({ error: "Project workspace has no workspace command configuration" });
      return;
    }

    const actor = getActorInfo(req);
    const recorder = workspaceOperationService(db).createRecorder({ companyId: project.companyId });
    let runtimeServiceCount = workspace.runtimeServices?.length ?? 0;
    let stdout = "";
    let stderr = "";

    const operation = await recorder.recordOperation({
      phase: action === "stop" ? "workspace_teardown" : "workspace_provision",
      command: workspaceCommand?.command ?? `workspace command ${action}`,
      cwd: workspace.cwd,
      metadata: {
        action,
        projectId: project.id,
        projectWorkspaceId: workspace.id,
        workspaceCommandId: workspaceCommand?.id ?? target.workspaceCommandId ?? null,
        workspaceCommandKind: workspaceCommand?.kind ?? null,
        workspaceCommandName: workspaceCommand?.name ?? null,
        runtimeServiceId: selectedRuntimeServiceId,
        serviceIndex: selectedServiceIndex,
      },
      run: async () => {
        if (action === "run") {
          if (!workspaceCommand || workspaceCommand.kind !== "job") {
            throw new Error("Workspace job selection is required");
          }
          return await runWorkspaceJobForControl({
            actor: {
              id: actor.agentId ?? null,
              name: actor.actorType === "user" ? "Board" : "Agent",
              companyId: project.companyId,
            },
            issue: null,
            workspace: {
              baseCwd: workspaceCwd,
              source: "project_primary",
              projectId: project.id,
              workspaceId: workspace.id,
              repoUrl: workspace.repoUrl,
              repoRef: workspace.repoRef,
              strategy: "project_primary",
              cwd: workspaceCwd,
              branchName: workspace.defaultRef ?? workspace.repoRef ?? null,
              worktreePath: null,
              warnings: [],
              created: false,
            },
            command: workspaceCommand.rawConfig,
            adapterEnv: {},
            recorder,
            metadata: {
              action,
              projectId: project.id,
              projectWorkspaceId: workspace.id,
              workspaceCommandId: workspaceCommand.id,
            },
          }).then((nestedOperation) => ({
            status: "succeeded" as const,
            exitCode: 0,
            metadata: {
              nestedOperationId: nestedOperation?.id ?? null,
              runtimeServiceCount,
            },
          }));
        }

        const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
          if (stream === "stdout") stdout = appendWithCap(stdout, chunk, WORKSPACE_CONTROL_OUTPUT_MAX_CHARS);
          else stderr = appendWithCap(stderr, chunk, WORKSPACE_CONTROL_OUTPUT_MAX_CHARS);
        };

        if (action === "stop" || action === "restart") {
          await stopRuntimeServicesForProjectWorkspace({
            db,
            projectWorkspaceId: workspace.id,
            runtimeServiceId: selectedRuntimeServiceId,
          });
        }

        if (action === "start" || action === "restart") {
          const startedServices = await startRuntimeServicesForWorkspaceControl({
            db,
            actor: {
              id: actor.agentId ?? null,
              name: actor.actorType === "user" ? "Board" : "Agent",
              companyId: project.companyId,
            },
            issue: null,
            workspace: {
              baseCwd: workspaceCwd,
              source: "project_primary",
              projectId: project.id,
              workspaceId: workspace.id,
              repoUrl: workspace.repoUrl,
              repoRef: workspace.repoRef,
              strategy: "project_primary",
              cwd: workspaceCwd,
              branchName: workspace.defaultRef ?? workspace.repoRef ?? null,
              worktreePath: null,
              warnings: [],
              created: false,
            },
            config: { workspaceRuntime: runtimeConfig },
            adapterEnv: {},
            onLog,
            serviceIndex: selectedServiceIndex,
          });
          runtimeServiceCount = startedServices.length;
        } else {
          runtimeServiceCount = selectedRuntimeServiceId ? Math.max(0, (workspace.runtimeServices?.length ?? 1) - 1) : 0;
        }

        const currentDesiredState: WorkspaceRuntimeDesiredState =
          workspace.runtimeConfig?.desiredState
          ?? ((workspace.runtimeServices ?? []).some((service) => service.status === "starting" || service.status === "running")
            ? "running"
            : "stopped");
        const nextRuntimeState: {
          desiredState: WorkspaceRuntimeDesiredState;
          serviceStates: WorkspaceRuntimeServiceStateMap | null | undefined;
        } = selectedRuntimeServiceId && (selectedServiceIndex === undefined || selectedServiceIndex === null)
          ? {
              desiredState: currentDesiredState,
              serviceStates: workspace.runtimeConfig?.serviceStates ?? null,
            }
          : buildWorkspaceRuntimeDesiredStatePatch({
              config: { workspaceRuntime: runtimeConfig },
              currentDesiredState,
              currentServiceStates: workspace.runtimeConfig?.serviceStates ?? null,
              action,
              serviceIndex: selectedServiceIndex,
            });
        await svc.updateWorkspace(project.id, workspace.id, {
          runtimeConfig: {
            desiredState: nextRuntimeState.desiredState,
            serviceStates: nextRuntimeState.serviceStates,
          },
        });

        return {
          status: "succeeded",
          stdout,
          stderr,
          system:
            action === "stop"
              ? "Stopped project workspace runtime services.\nThis does not pause issue work or held wake scheduling."
              : action === "restart"
                ? "Restarted project workspace runtime services.\nThis does not pause issue work or held wake scheduling."
                : "Started project workspace runtime services.\n",
          metadata: {
            runtimeServiceCount,
            workspaceCommandId: workspaceCommand?.id ?? target.workspaceCommandId ?? null,
            runtimeServiceId: selectedRuntimeServiceId,
            serviceIndex: selectedServiceIndex,
          },
        };
      },
    });

    const updatedWorkspace = (await svc.listWorkspaces(project.id)).find((entry) => entry.id === workspace.id) ?? workspace;

    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: `project.workspace_runtime_${action}`,
      entityType: "project",
      entityId: project.id,
      details: {
        projectWorkspaceId: workspace.id,
        runtimeServiceCount,
        workspaceCommandId: workspaceCommand?.id ?? target.workspaceCommandId ?? null,
        workspaceCommandKind: workspaceCommand?.kind ?? null,
        workspaceCommandName: workspaceCommand?.name ?? null,
        runtimeServiceId: selectedRuntimeServiceId,
        serviceIndex: selectedServiceIndex,
      },
    });

    res.json({
      workspace: updatedWorkspace,
      operation,
    });
  }

  router.post("/projects/:id/workspaces/:workspaceId/runtime-services/:action", validate(workspaceRuntimeControlTargetSchema), handleProjectWorkspaceRuntimeCommand);
  router.post("/projects/:id/workspaces/:workspaceId/runtime-commands/:action", validate(workspaceRuntimeControlTargetSchema), handleProjectWorkspaceRuntimeCommand);

  // ── Requirement Analysis — dispatch to lead agent ──
  router.post("/projects/:id/requirement-analysis/generate", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);

    const body = req.body as { agentType?: unknown; requirements?: unknown };
    if (
      (body.agentType !== "requirement-breakdown" && body.agentType !== "sow") ||
      typeof body.requirements !== "string"
    ) {
      res.status(400).json({ error: "agentType and requirements are required" });
      return;
    }
    const agentType = body.agentType as "requirement-breakdown" | "sow";
    const requirements = (body.requirements as string).trim();

    let leadAgent: typeof agents.$inferSelect | undefined;

    if (project.leadAgentId) {
      [leadAgent] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, project.leadAgentId), ne(agents.status, "terminated")))
        .limit(1);
    }

    if (!leadAgent) {
      const activeAgents = await db
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, project.companyId), ne(agents.status, "terminated")))
        .limit(2000);
      leadAgent = pickRequirementAnalysisLeadAgent(activeAgents);
    }

    if (!leadAgent) {
      res.status(422).json({ error: "No active agent found in this company. Create an agent first." });
      return;
    }

    const actor = getActorInfo(req);
    const title = agentType === "sow"
      ? `SOW: ${project.name}`
      : `Requirements Breakdown: ${project.name}`;
    const docType = agentType === "sow" ? "Statement of Work" : "Requirements Breakdown";
    const description = `Generate a ${docType} for project **${project.name}**.\n\n## Requirements\n\n${requirements}\n\nOnce complete, save the output using the "save" endpoint.`;

    const issue = await issueSvc.create(project.companyId, {
      title,
      description,
      projectId: project.id,
      assigneeAgentId: leadAgent.id,
      status: "todo",
      priority: "high",
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      originKind: "automation",
    });

    await heartbeat.wakeup(leadAgent.id, {
      source: "on_demand",
      triggerDetail: "system",
      reason: "requirement_analysis",
      payload: {
        agentType,
        requirements,
        projectId: project.id,
      },
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId ?? null,
      contextSnapshot: {
        issueId: issue.id,
        taskId: issue.id,
        wakeReason: "requirement_analysis",
      },
    });

    res.json({ issueId: issue.id, identifier: issue.identifier ?? null });
  });

  // ── Requirement Analysis — save ──
  router.post("/projects/:id/requirement-analysis/save", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);

    const body = req.body as { agentType?: unknown; title?: unknown; content?: unknown };
    if (
      (body.agentType !== "requirement-breakdown" && body.agentType !== "sow") ||
      typeof body.title !== "string" || body.title.trim().length === 0 ||
      typeof body.content !== "string" || body.content.trim().length === 0
    ) {
      res.status(400).json({ error: "agentType, title, and content are required" });
      return;
    }

    const [row] = await db
      .insert(projectRequirementAnalyses)
      .values({
        companyId: project.companyId,
        projectId: id,
        agentType: body.agentType as string,
        title: (body.title as string).trim(),
        content: (body.content as string).trim(),
      })
      .returning();

    res.status(201).json(row);
  });

  // ── Requirement Analysis — list saved ──
  router.get("/projects/:id/requirement-analysis/saved", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);

    const rows = await db
      .select()
      .from(projectRequirementAnalyses)
      .where(eq(projectRequirementAnalyses.projectId, id))
      .orderBy(descOrd(projectRequirementAnalyses.createdAt));

    res.json(rows);
  });

  router.post("/projects/:id/requirement-analysis/share-with-shovan", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);

    const body = req.body as { agentType?: unknown; title?: unknown; content?: unknown };
    if (
      (body.agentType !== "requirement-breakdown" && body.agentType !== "sow") ||
      typeof body.title !== "string" || body.title.trim().length === 0 ||
      typeof body.content !== "string" || body.content.trim().length === 0
    ) {
      res.status(400).json({ error: "agentType, title, and content are required" });
      return;
    }

    const graphConfig = readGraphMailConfig();
    if (!graphConfig) {
      res.status(422).json({
        error:
          "Microsoft Graph email is not configured. Set MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET, and MS_GRAPH_SENDER_USER_ID.",
      });
      return;
    }

    const shovanEmail = process.env.PAPERCLIP_SHOVAN_EMAIL?.trim() ?? "";
    const managerEmail = project.managerEmail?.trim() ?? "";
    const clientEmails = (project.clientEmail ?? []).filter((e) => e.trim().length > 0);
    if (!shovanEmail) {
      res.status(422).json({
        error:
          "Shovan email is not configured. Set PAPERCLIP_SHOVAN_EMAIL.",
      });
      return;
    }
    if (!managerEmail || clientEmails.length === 0) {
      res.status(422).json({
        error:
          "Project manager/client emails are required. Set Manager Email and Client Email in project configuration.",
      });
      return;
    }

    const cleanedTitle = (body.title as string).trim();
    const cleanedContent = (body.content as string).trim();
      const approvalToken = randomUUID();
    const publicBaseUrl = (process.env.PAPERCLIP_PUBLIC_URL?.trim() || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
    const approveUrl = `${publicBaseUrl}/api/projects/requirement-analysis/share-approval/${encodeURIComponent(approvalToken)}?action=approve`;
    const rejectUrl = `${publicBaseUrl}/api/projects/requirement-analysis/share-approval/${encodeURIComponent(approvalToken)}?action=reject`;

    const [share] = await db
      .insert(projectRequirementAnalysisShares)
      .values({
        companyId: project.companyId,
        projectId: id,
        analysisId: null,
        agentType: body.agentType as string,
        title: cleanedTitle,
        content: cleanedContent,
        shovanEmail,
        managerEmail,
        clientEmail: clientEmails,
        status: "pending",
        approvalToken,
      })
      .returning();

    try {
      await sendGraphMail(graphConfig, {
        to: shovanEmail,
        subject: `Approval Requested: ${cleanedTitle}`,
        html: [
          `<p>Hi Shovan,</p>`,
          `<p>Please review and approve this document for project <strong>${escapeHtml(project.name)}</strong>.</p>`,
          `<p><strong>Title:</strong> ${escapeHtml(cleanedTitle)}</p>`,
          `<p>Choose an action:</p>`,
          `<p><a href="${approveUrl}">Approve and notify manager</a></p>`,
          `<p><a href="${rejectUrl}">Reject</a></p>`,
        ].join(""),
        wordAttachmentName: `${cleanedTitle.replace(/[^a-zA-Z0-9._-]+/g, "_") || "analysis"}.doc`,
        wordAttachmentContent: cleanedContent,
      });
    } catch (err) {
      await db
        .update(projectRequirementAnalysisShares)
        .set({
          status: "failed",
          updatedAt: new Date(),
        })
        .where(eq(projectRequirementAnalysisShares.id, share.id));
      res.status(502).json({
        error: err instanceof Error ? err.message : "Failed to send approval email",
      });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.requirement_analysis_shared_for_approval",
      entityType: "project",
      entityId: id,
      details: {
        shareId: share.id,
        shovanEmail,
        agentType: body.agentType,
      },
    });

    res.status(201).json({
      id: share.id,
      status: share.status,
      shovanEmail: share.shovanEmail,
      createdAt: share.createdAt,
    });
  });

  router.get("/projects/requirement-analysis/share-approval/:token", async (req, res) => {
    const token = req.params.token as string;
    const action = req.query.action === "reject" ? "reject" : "approve";
    const share = await db
      .select()
      .from(projectRequirementAnalysisShares)
      .where(eq(projectRequirementAnalysisShares.approvalToken, token))
      .then((rows) => rows[0] ?? null);

    if (!share) {
      res.status(404).type("text/plain").send("Approval request not found.");
      return;
    }

    if (share.status !== "pending") {
      res.status(200).type("text/plain").send(`This approval request is already ${share.status}.`);
      return;
    }

    const graphConfig = readGraphMailConfig();
    if (!graphConfig) {
      res.status(500).type("text/plain").send("Server email integration is not configured.");
      return;
    }

    if (action === "reject") {
      await db
        .update(projectRequirementAnalysisShares)
        .set({
          status: "rejected",
          rejectedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(projectRequirementAnalysisShares.id, share.id));
      await logActivity(db, {
        companyId: share.companyId,
        actorType: "user",
        actorId: "email-link",
        action: "project.requirement_analysis_share_rejected",
        entityType: "project",
        entityId: share.projectId,
        details: {
          shareId: share.id,
          shovanEmail: share.shovanEmail,
        },
      });
      res.type("text/plain").send("Rejected. The document was not shared.");
      return;
    }

    await db
      .update(projectRequirementAnalysisShares)
      .set({
        status: "approved",
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(projectRequirementAnalysisShares.id, share.id));

    const project = await svc.getById(share.projectId);
    const projectName = project?.name ?? "Project";
    const sanitizedFilename = `${share.title.replace(/[^a-zA-Z0-9._-]+/g, "_") || "analysis"}.doc`;
    const sharedHtml = [
      `<p>Hi,</p>`,
      `<p>Shovan approved this ${escapeHtml(share.agentType)} document for <strong>${escapeHtml(projectName)}</strong>.</p>`,
      `<p><strong>Title:</strong> ${escapeHtml(share.title)}</p>`,
      `<p>Manager action is required to share it with the client from the project workspace.</p>`,
      `<p>Please find the Word document attached for your review.</p>`,
    ].join("");

    try {
      if (share.managerEmail) {
        await sendGraphMail(graphConfig, {
          to: share.managerEmail,
          subject: `Shovan Approved: ${share.title}`,
          html: sharedHtml,
          wordAttachmentName: sanitizedFilename,
          wordAttachmentContent: share.content,
        });
      }
    } catch (err) {
      res
        .status(502)
        .type("text/plain")
        .send(`Approved, but manager notification failed: ${err instanceof Error ? err.message : "unknown error"}`);
      return;
    }

    await logActivity(db, {
      companyId: share.companyId,
      actorType: "user",
      actorId: "email-link",
      action: "project.requirement_analysis_share_approved",
      entityType: "project",
      entityId: share.projectId,
      details: {
        shareId: share.id,
        managerEmail: share.managerEmail,
      },
    });

    res.type("text/plain").send("Approved. Manager has been notified and can now share with client from the project workspace.");
  });

  router.post("/projects/:id/requirement-analysis/share-with-client", async (req, res) => {
    const projectId = req.params.id as string;
    const project = await svc.getById(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);

    const body = req.body as { shareId?: unknown };
    if (typeof body.shareId !== "string" || body.shareId.trim().length === 0) {
      res.status(400).json({ error: "shareId is required" });
      return;
    }

    const share = await db
      .select()
      .from(projectRequirementAnalysisShares)
      .where(
        and(
          eq(projectRequirementAnalysisShares.id, body.shareId.trim()),
          eq(projectRequirementAnalysisShares.projectId, projectId),
          eq(projectRequirementAnalysisShares.companyId, project.companyId),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (!share) {
      res.status(404).json({ error: "Share not found" });
      return;
    }

    if (share.status === "client_shared") {
      res.status(200).json({
        id: share.id,
        status: share.status,
        clientEmail: share.clientEmail,
      });
      return;
    }

    if (share.status !== "approved") {
      res.status(409).json({ error: "Share must be approved by Shovan before sharing with client" });
      return;
    }

    const clientEmails = (share.clientEmail ?? []).filter((value) => value.trim().length > 0);
    if (clientEmails.length === 0) {
      res.status(422).json({ error: "Project client email is required before sharing with client" });
      return;
    }

    const graphConfig = readGraphMailConfig();
    if (!graphConfig) {
      res.status(422).json({
        error:
          "Microsoft Graph email is not configured. Set MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET, and MS_GRAPH_SENDER_USER_ID.",
      });
      return;
    }

    const projectName = project.name ?? "Project";
    const sanitizedFilename = `${share.title.replace(/[^a-zA-Z0-9._-]+/g, "_") || "analysis"}.doc`;
    const clientHtml = [
      `<p>Hi,</p>`,
      `<p>Please find the approved ${escapeHtml(share.agentType)} document for <strong>${escapeHtml(projectName)}</strong>.</p>`,
      `<p><strong>Title:</strong> ${escapeHtml(share.title)}</p>`,
      `<p>The Word document is attached.</p>`,
    ].join("");

    try {
      for (const clientEmail of clientEmails) {
        await sendGraphMail(graphConfig, {
          to: clientEmail,
          subject: `Approved Document: ${share.title}`,
          html: clientHtml,
          wordAttachmentName: sanitizedFilename,
          wordAttachmentContent: share.content,
        });
      }
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : "Failed to share with client",
      });
      return;
    }

    const [updatedShare] = await db
      .update(projectRequirementAnalysisShares)
      .set({
        status: "client_shared",
        updatedAt: new Date(),
      })
      .where(eq(projectRequirementAnalysisShares.id, share.id))
      .returning();

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: share.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.requirement_analysis_shared_with_client",
      entityType: "project",
      entityId: share.projectId,
      details: {
        shareId: share.id,
        clientEmail: clientEmails,
      },
    });

    res.status(200).json({
      id: updatedShare.id,
      status: updatedShare.status,
      clientEmail: updatedShare.clientEmail,
      updatedAt: updatedShare.updatedAt,
    });
  });

  router.get("/projects/:id/requirement-analysis/share-status/:shareId", async (req, res) => {
    const projectId = req.params.id as string;
    const shareId = req.params.shareId as string;

    const project = await svc.getById(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);

    const share = await db
      .select()
      .from(projectRequirementAnalysisShares)
      .where(eq(projectRequirementAnalysisShares.id, shareId))
      .then((rows) => rows[0] ?? null);

    if (!share) {
      res.status(404).json({ error: "Share not found" });
      return;
    }

    res.status(200).json({
      id: share.id,
      status: share.status,
      shovanEmail: share.shovanEmail,
      managerEmail: share.managerEmail,
      clientEmail: share.clientEmail,
      createdAt: share.createdAt,
      approvedAt: share.approvedAt,
    });
  });

  router.get("/projects/:id/requirement-analysis/latest-share", async (req, res) => {
    const projectId = req.params.id as string;
    const agentType = req.query.agentType as string | undefined;

    if (agentType && agentType !== "requirement-breakdown" && agentType !== "sow") {
      res.status(400).json({ error: "agentType must be requirement-breakdown or sow" });
      return;
    }

    const project = await svc.getById(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);

    const share = await db
      .select()
      .from(projectRequirementAnalysisShares)
      .where(
        agentType
          ? and(
              eq(projectRequirementAnalysisShares.projectId, projectId),
              eq(projectRequirementAnalysisShares.agentType, agentType),
            )
          : eq(projectRequirementAnalysisShares.projectId, projectId),
      )
      .orderBy(descOrd(projectRequirementAnalysisShares.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!share) {
      res.status(200).json(null);
      return;
    }

    res.status(200).json({
      id: share.id,
      status: share.status,
      shovanEmail: share.shovanEmail,
      managerEmail: share.managerEmail,
      clientEmail: share.clientEmail,
      createdAt: share.createdAt,
      approvedAt: share.approvedAt,
      rejectedAt: share.rejectedAt,
    });
  });

  router.delete("/projects/:id/workspaces/:workspaceId", async (req, res) => {
    const id = req.params.id as string;
    const workspaceId = req.params.workspaceId as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const workspace = await svc.removeWorkspace(id, workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "Project workspace not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.workspace_deleted",
      entityType: "project",
      entityId: id,
      details: {
        workspaceId: workspace.id,
        name: workspace.name,
      },
    });

    res.json(workspace);
  });

  router.delete("/projects/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const project = await svc.remove(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.deleted",
      entityType: "project",
      entityId: project.id,
    });

    res.json(project);
  });

  return router;
}
