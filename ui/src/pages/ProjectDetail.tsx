import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { Link, useParams, useNavigate, useLocation, Navigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PROJECT_COLORS, isUuidLike, type BudgetPolicySummary } from "@paperclipai/shared";
import { budgetsApi } from "../api/budgets";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { instanceSettingsApi } from "../api/instanceSettings";
import { projectsApi } from "../api/projects";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { assetsApi } from "../api/assets";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ProjectProperties, type ProjectConfigFieldKey, type ProjectFieldSaveState } from "../components/ProjectProperties";
import { InlineEditor } from "../components/InlineEditor";
import { StatusBadge } from "../components/StatusBadge";
import { BudgetPolicyCard } from "../components/BudgetPolicyCard";
import { IssuesList } from "../components/IssuesList";
import { PageSkeleton } from "../components/PageSkeleton";
import { PageTabBar } from "../components/PageTabBar";
import { ProjectWorkspacesContent } from "../components/ProjectWorkspacesContent";
import { buildProjectWorkspaceSummaries } from "../lib/project-workspaces-tab";
import { collectLiveIssueIds } from "../lib/liveIssueIds";
import { projectRouteRef } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { PluginSlotMount, PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";

/* ── Top-level tab types ── */

type ProjectBaseTab = "overview" | "list" | "plugin-operations" | "workspaces" | "configuration" | "requirement-analysis" | "budget";
type ProjectPluginTab = `plugin:${string}`;
type ProjectTab = ProjectBaseTab | ProjectPluginTab;

function isProjectPluginTab(value: string | null): value is ProjectPluginTab {
  return typeof value === "string" && value.startsWith("plugin:");
}

function resolveProjectTab(pathname: string, projectId: string): ProjectTab | null {
  const segments = pathname.split("/").filter(Boolean);
  const projectsIdx = segments.indexOf("projects");
  if (projectsIdx === -1 || segments[projectsIdx + 1] !== projectId) return null;
  const tab = segments[projectsIdx + 2];
  if (tab === "overview") return "overview";
  if (tab === "configuration") return "configuration";
  if (tab === "requirement-analysis") return "requirement-analysis";
  if (tab === "budget") return "budget";
  if (tab === "issues") return "list";
  if (tab === "plugin-operations") return "plugin-operations";
  if (tab === "workspaces") return "workspaces";
  return null;
}

/* ── Overview tab content ── */

function OverviewContent({
  project,
  onUpdate,
  imageUploadHandler,
}: {
  project: { description: string | null; status: string; targetDate: string | null };
  onUpdate: (data: Record<string, unknown>) => void;
  imageUploadHandler?: (file: File) => Promise<string>;
}) {
  return (
    <div className="space-y-6">
      <InlineEditor
        value={project.description ?? ""}
        onSave={(description) => onUpdate({ description })}
        nullable
        as="p"
        className="text-sm text-muted-foreground"
        placeholder="Add a description..."
        multiline
        imageUploadHandler={imageUploadHandler}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
        <div>
          <span className="text-muted-foreground">Status</span>
          <div className="mt-1">
            <StatusBadge status={project.status} />
          </div>
        </div>
        {project.targetDate && (
          <div>
            <span className="text-muted-foreground">Target Date</span>
            <p>{project.targetDate}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Color picker popover ── */

function ColorPicker({
  currentColor,
  onSelect,
}: {
  currentColor: string;
  onSelect: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="shrink-0 h-5 w-5 rounded-md cursor-pointer hover:ring-2 hover:ring-foreground/20 transition-[box-shadow]"
        style={{ backgroundColor: currentColor }}
        aria-label="Change project color"
      />
      {open && (
        <div className="absolute top-full left-0 mt-2 p-2 bg-popover border border-border rounded-lg shadow-lg z-50 w-max">
          <div className="grid grid-cols-5 gap-1.5">
            {PROJECT_COLORS.map((color) => (
              <button
                key={color}
                onClick={() => {
                  onSelect(color);
                  setOpen(false);
                }}
                className={`h-6 w-6 rounded-md cursor-pointer transition-[transform,box-shadow] duration-150 hover:scale-110 ${
                  color === currentColor
                    ? "ring-2 ring-foreground ring-offset-1 ring-offset-background"
                    : "hover:ring-2 hover:ring-foreground/30"
                }`}
                style={{ backgroundColor: color }}
                aria-label={`Select color ${color}`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── List (issues) tab content ── */

function ProjectIssuesList({ projectId, companyId }: { projectId: string; companyId: string }) {
  const queryClient = useQueryClient();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    enabled: !!companyId,
    refetchInterval: 5000,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: !!companyId,
  });

  const liveIssueIds = useMemo(() => collectLiveIssueIds(liveRuns), [liveRuns]);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.listByProject(companyId, projectId),
    queryFn: () => issuesApi.list(companyId, { projectId }),
    enabled: !!companyId,
  });

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    },
  });

  return (
    <IssuesList
      issues={issues ?? []}
      isLoading={isLoading}
      error={error as Error | null}
      agents={agents}
      projects={projects}
      liveIssueIds={liveIssueIds}
      projectId={projectId}
      viewStateKey="paperclip:project-issues-view"
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
    />
  );
}

function ProjectPluginOperationsList({
  projectId,
  companyId,
  pluginKey,
}: {
  projectId: string;
  companyId: string;
  pluginKey: string;
}) {
  const queryClient = useQueryClient();
  const originKindPrefix = `plugin:${pluginKey}`;

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: !!companyId,
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    enabled: !!companyId,
    refetchInterval: 5000,
  });
  const liveIssueIds = useMemo(() => collectLiveIssueIds(liveRuns), [liveRuns]);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.listPluginOperationsByProject(companyId, projectId, originKindPrefix),
    queryFn: () => issuesApi.list(companyId, { projectId, originKindPrefix }),
    enabled: !!companyId && !!projectId,
  });

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listPluginOperationsByProject(companyId, projectId, originKindPrefix) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    },
  });

  return (
    <IssuesList
      issues={issues ?? []}
      isLoading={isLoading}
      error={error as Error | null}
      agents={agents}
      projects={projects}
      liveIssueIds={liveIssueIds}
      projectId={projectId}
      viewStateKey={`paperclip:project-plugin-operations-view:${pluginKey}`}
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
    />
  );
}

/* ── Requirement Analysis Workspace ── */

type AgentType = "requirement-breakdown" | "sow";

function isAgentType(value: string): value is AgentType {
  return value === "requirement-breakdown" || value === "sow";
}

interface UploadedFile {
  id: string;
  name: string;
  size: number;
  type: string;
}

function FileTypeIcon({ type }: { type: string }) {
  if (type.includes("pdf"))
    return (
      <svg className="h-3.5 w-3.5 shrink-0 text-red-400" fill="currentColor" viewBox="0 0 24 24">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" />
      </svg>
    );
  if (
    type.includes("spreadsheet") ||
    type.includes("excel") ||
    type.includes("csv") ||
    type.includes("xls")
  )
    return (
      <svg className="h-3.5 w-3.5 shrink-0 text-emerald-400" fill="currentColor" viewBox="0 0 24 24">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" />
      </svg>
    );
  if (type.startsWith("image/"))
    return (
      <svg
        className="h-3.5 w-3.5 shrink-0 text-blue-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
        />
      </svg>
    );
  return (
    <svg className="h-3.5 w-3.5 shrink-0 text-muted-foreground" fill="currentColor" viewBox="0 0 24 24">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" />
    </svg>
  );
}

function TrackerStatusChip({ status }: { status: string }) {
  if (status === "done")
    return (
      <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400">
        Done
      </span>
    );
  if (status === "pending")
    return (
      <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-400">
        Pending
      </span>
    );
  if (status === "clickup")
    return (
      <span className="rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet-400">
        ClickUp
      </span>
    );
  if (status === "rejected")
    return (
      <span className="rounded-full border border-rose-500/20 bg-rose-500/10 px-2 py-0.5 text-xs font-medium text-rose-400">
        Rejected
      </span>
    );
  return null;
}

const DEFAULT_SOW_TRACKER_ITEMS = [
  { label: "SOW Created", status: "pending" as const },
  { label: "Share with Shovan", status: "pending" as const },
  { label: "Shovan Review", status: "pending" as const },
  { label: "Share with Client", status: "pending" as const },
] as const;

function RequirementAnalysisWorkspace({
  projectId,
  companyId,
}: {
  projectId: string;
  companyId: string | undefined;
}) {
  const [selectedAgent, setSelectedAgent] = useState<AgentType | null>(null);
  const [requirements, setRequirements] = useState("");
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [isOutputEdited, setIsOutputEdited] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isCurrentOutputSaved, setIsCurrentOutputSaved] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [isSharingWithShovan, setIsSharingWithShovan] = useState(false);
  const [isSharingWithClient, setIsSharingWithClient] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareWithClientError, setShareWithClientError] = useState<string | null>(null);
  const [isSharedWithShovan, setIsSharedWithShovan] = useState(false);
  const [shareId, setShareId] = useState<string | null>(null);
  const [isShovanApproved, setIsShovanApproved] = useState(false);
  const [latestShareStatus, setLatestShareStatus] = useState<"none" | "pending" | "approved" | "rejected" | "failed" | "client_shared">("none");
  const { pushToast } = useToastActions();
  const [savedAnalyses, setSavedAnalyses] = useState<Array<{
    id: string; agentType: string; title: string; content: string; createdAt: string;
  }>>([]);
  const [selectedSavedId, setSelectedSavedId] = useState<string | null>(null);

  const handleAgentSelect = (agent: AgentType) => {
    setSelectedAgent(agent);
    const latestForAgent = savedAnalyses.find((row) => row.agentType === agent);
    if (latestForAgent) {
      setOutput(latestForAgent.content);
      setSelectedSavedId(latestForAgent.id);
      setIsCurrentOutputSaved(true);
    } else {
      setOutput(null);
      setSelectedSavedId(null);
      setIsCurrentOutputSaved(false);
    }
    setIsOutputEdited(false);
    setGenerateError(null);
    setSaveError(null);
    setShareError(null);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const newFiles: UploadedFile[] = files.map((f) => ({
      id: `${f.name}-${Date.now()}-${Math.random()}`,
      name: f.name,
      size: f.size,
      type: f.type,
    }));
    setUploadedFiles((prev) => [...prev, ...newFiles]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeFile = (id: string) => {
    setUploadedFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const handleRegenerate = async () => {
    setOutput(null);
    setIsCurrentOutputSaved(false);
    setIsOutputEdited(false);
    setIsSharedWithShovan(false);
    setShareId(null);
    setIsShovanApproved(false);
    setLatestShareStatus("none");
    setShareWithClientError(null);
    await handleGenerate();
  };

  const handleSaveToSharePoint = () => {
    pushToast({ title: "SharePoint not configured", body: "Set up SharePoint integration in your environment settings to enable this feature.", tone: "info" });
  };

  const handleGenerate = async () => {
    if (!selectedAgent) return;
    setIsGenerating(true);
    setGenerateError(null);
    setOutput(null);
    try {
      const result = await projectsApi.generateRequirementAnalysis(
        projectId,
        { agentType: selectedAgent, requirements },
        companyId,
      );
      setOutput(result.output);
      setSelectedSavedId(null);
      setIsCurrentOutputSaved(false);
      setIsOutputEdited(false);
      setIsSharedWithShovan(false);
      setShareId(null);
      setIsShovanApproved(false);
      setLatestShareStatus("none");
      setShareWithClientError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Generation failed. Please try again.";
      setGenerateError(msg);
    } finally {
      setIsGenerating(false);
    }
  };

  // Poll for Shovan approval status
  useEffect(() => {
    if (!isSharedWithShovan || !shareId || isShovanApproved) return;
    const interval = setInterval(() => {
      projectsApi
        .getShareApprovalStatus(projectId, shareId, companyId)
        .then((share) => {
          setLatestShareStatus(share.status);
          if (share.status === "approved" || share.status === "client_shared") {
            setIsShovanApproved(true);
          }
          if (share.status === "rejected") {
            setIsShovanApproved(false);
          }
        })
        .catch(() => {
          /* ignore errors during polling */
        });
    }, 3000);
    return () => clearInterval(interval);
  }, [isSharedWithShovan, shareId, isShovanApproved, projectId, companyId]);

  // Restore latest persisted SOW share status so tracker survives reloads.
  useEffect(() => {
    if (selectedAgent !== "sow") return;

    let disposed = false;
    projectsApi
      .getLatestRequirementAnalysisShare(projectId, "sow", companyId)
      .then((latestShare) => {
        if (disposed) return;
        if (!latestShare) {
          setIsSharedWithShovan(false);
          setShareId(null);
          setIsShovanApproved(false);
          setLatestShareStatus("none");
          return;
        }
        setIsSharedWithShovan(true);
        setShareId(latestShare.id);
        setLatestShareStatus(latestShare.status);
        setIsShovanApproved(latestShare.status === "approved" || latestShare.status === "client_shared");
      })
      .catch(() => {
        /* non-fatal */
      });

    return () => {
      disposed = true;
    };
  }, [selectedAgent, projectId, companyId]);

  const isShovanRejected = latestShareStatus === "rejected";
  const isSharedWithClient = latestShareStatus === "client_shared";
  const canReshareWithShovan = latestShareStatus === "rejected" || latestShareStatus === "failed";

  // Load saved analyses on mount
  useEffect(() => {
    projectsApi.listSavedRequirementAnalyses(projectId, companyId)
      .then((rows) => {
        setSavedAnalyses(rows);
        if (rows.length === 0) return;
        const latest = rows[0];
        setSelectedSavedId(latest.id);
        setOutput(latest.content);
        setIsCurrentOutputSaved(true);
        if (isAgentType(latest.agentType)) {
          setSelectedAgent(latest.agentType);
        }
      })
      .catch(() => { /* non-fatal */ });
  }, [projectId, companyId]);

  const handleSave = async () => {
    if (!output || !selectedAgent) return;
    setIsSaving(true);
    setSaveError(null);
    const agentLabel = selectedAgent === "sow" ? "SOW" : "Requirement Breakdown";
    const title = `${agentLabel} — ${new Date().toLocaleDateString()}`;
    try {
      const saved = await projectsApi.saveRequirementAnalysis(
        projectId,
        { agentType: selectedAgent, title, content: output },
        companyId,
      );
      setSavedAnalyses((prev) => [saved, ...prev]);
      setSelectedSavedId(saved.id);
      setIsCurrentOutputSaved(true);
      setIsOutputEdited(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed. Please try again.";
      setSaveError(msg);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCopy = () => {
    if (!output) return;
    void navigator.clipboard.writeText(output);
    setIsCopied(true);
    window.setTimeout(() => setIsCopied(false), 1500);
  };

  const handleDownload = () => {
    if (!output) return;
    const wordHtml = [
      "<html><head><meta charset=\"utf-8\"></head><body>",
      `<pre style=\"font-family:Calibri,Arial,sans-serif;font-size:11pt;white-space:pre-wrap;\">${output
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")}</pre>`,
      "</body></html>",
    ].join("");
    const blob = new Blob([wordHtml], { type: "application/msword" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "Output.doc";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleShareWithShovan = async () => {
    if (!output || !selectedAgent) return;
    setIsSharingWithShovan(true);
    setShareError(null);
    const agentLabel = selectedAgent === "sow" ? "SOW" : "Requirement Breakdown";
    const title = `${agentLabel} — ${new Date().toLocaleDateString()}`;
    try {
      const response = await projectsApi.shareRequirementAnalysisWithShovan(
        projectId,
        { agentType: selectedAgent, title, content: output },
        companyId,
      );
      setIsSharedWithShovan(true);
      setShareId(response.id);
      setLatestShareStatus(response.status);
      setShareWithClientError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Share with Shovan failed. Please try again.";
      setShareError(msg);
    } finally {
      setIsSharingWithShovan(false);
    }
  };

  const handleShareWithClient = async () => {
    if (!shareId) return;
    setIsSharingWithClient(true);
    setShareWithClientError(null);
    try {
      const response = await projectsApi.shareRequirementAnalysisWithClient(
        projectId,
        { shareId },
        companyId,
      );
      setLatestShareStatus(response.status);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Share with client failed. Please try again.";
      setShareWithClientError(msg);
    } finally {
      setIsSharingWithClient(false);
    }
  };

  const getSowTrackerItems = useMemo(() => [
    { label: "SOW Created", status: output ? ("done" as const) : ("pending" as const) },
    { label: "Share with Shovan", status: isSharedWithShovan ? ("done" as const) : ("pending" as const) },
    {
      label: "Shovan Review",
      status: isShovanApproved
        ? ("done" as const)
        : isShovanRejected
          ? ("rejected" as const)
          : ("pending" as const),
    },
    { label: "Share with Client", status: isSharedWithClient ? ("done" as const) : ("pending" as const) },
  ], [output, isSharedWithShovan, isShovanApproved, isShovanRejected, isSharedWithClient]);

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const canGenerate = !isGenerating && (requirements.trim().length > 0 || uploadedFiles.length > 0);

  return (
    <div className="max-w-4xl space-y-5">
      {/* Agent selector card */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Requirement Analysis</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Launch dedicated agents to break down requirements or draft a Statement of Work.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant={selectedAgent === "requirement-breakdown" ? "default" : "outline"}
            onClick={() => handleAgentSelect("requirement-breakdown")}
          >
            Requirement Breakdown Agent
          </Button>
          <Button
            variant={selectedAgent === "sow" ? "default" : "outline"}
            onClick={() => handleAgentSelect("sow")}
          >
            SOW Agent
          </Button>
        </div>
      </div>

      {selectedAgent && (
        <>
          {/* AI Workspace */}
          <div className="rounded-lg border border-border bg-card p-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">
                {selectedAgent === "sow" ? "SOW Agent" : "Requirement Breakdown Agent"}
                {" — Workspace"}
              </h3>
              <span className="shrink-0 rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
                {selectedAgent === "sow" ? "Statement of Work" : "Breakdown"}
              </span>
            </div>

            {/* Textarea */}
            <textarea
              className="w-full min-h-[180px] resize-y rounded-md border border-border bg-background px-3 py-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring transition-colors"
              placeholder="Describe your project requirements in detail. Include scope, goals, stakeholders, constraints, and any technical considerations…"
              value={requirements}
              onChange={(e) => setRequirements(e.target.value)}
            />

            {/* Upload row */}
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                id="req-asset-upload"
                multiple
                accept=".pdf,.docx,.doc,.xlsx,.xls,.csv,.png,.jpg,.jpeg,.gif,.webp"
                className="sr-only"
                onChange={handleFileChange}
              />
              <label
                htmlFor="req-asset-upload"
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                  />
                </svg>
                Upload Assets
              </label>
              <span className="text-xs text-muted-foreground">PDF, DOCX, Excel, images</span>
            </div>

            {/* File chips */}
            {uploadedFiles.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {uploadedFiles.map((file) => (
                  <div
                    key={file.id}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1 text-xs text-foreground"
                  >
                    <FileTypeIcon type={file.type} />
                    <span className="max-w-[140px] truncate">{file.name}</span>
                    <span className="text-muted-foreground">({formatSize(file.size)})</span>
                    <button
                      onClick={() => removeFile(file.id)}
                      className="ml-0.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground"
                      aria-label={`Remove ${file.name}`}
                    >
                      <svg
                        className="h-3 w-3"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2.5}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Generate */}
            <div className="pt-1 space-y-2">
              <Button onClick={handleGenerate} disabled={!canGenerate} className="gap-2">
                {isGenerating ? (
                  <>
                    <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                      />
                    </svg>
                    Generating…
                  </>
                ) : (
                  <>
                    <svg
                      className="h-3.5 w-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    Generate
                  </>
                )}
              </Button>
              {generateError && (
                <p className="text-xs text-destructive">{generateError}</p>
              )}
            </div>
          </div>

          {/* Output section */}
          {output !== null && (
            <>
              <div className="rounded-lg border border-border bg-card p-5 space-y-4">
                {/* Output header */}
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">Output</h3>
                  <div className="flex items-center gap-2">
                    <span className="rounded border border-border bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
                      Output.doc
                    </span>
                    <button
                      onClick={handleCopy}
                      title="Copy to clipboard"
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <svg
                        className="h-3.5 w-3.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                        />
                      </svg>
                      {isCopied ? "Copied" : "Copy"}
                    </button>
                    <button
                      onClick={handleDownload}
                      title="Download as .doc"
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <svg
                        className="h-3.5 w-3.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                        />
                      </svg>
                      Download
                    </button>
                    <button
                      onClick={handleRegenerate}
                      disabled={isGenerating || !canGenerate}
                      title="Regenerate output"
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <svg
                        className={`h-3.5 w-3.5 ${isGenerating ? "animate-spin" : ""}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      {isGenerating ? "Generating…" : "Regenerate"}
                    </button>
                  </div>
                </div>

                {/* Markdown editor */}
                <textarea
                  value={output || ""}
                  onChange={(e) => {
                    setOutput(e.target.value);
                    setIsOutputEdited(true);
                  }}
                  className="max-h-[480px] min-h-[220px] w-full overflow-auto rounded-md border border-border bg-background p-4 font-mono text-xs leading-relaxed text-foreground resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="Output will appear here..."
                />

                {/* Save actions */}
                <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                  <Button
                    size="sm"
                    onClick={handleSave}
                    disabled={isSaving || (!isOutputEdited && isCurrentOutputSaved) || !selectedAgent || output.trim().length === 0}
                  >
                    {isSaving ? "Saving…" : isOutputEdited ? "Save" : isCurrentOutputSaved ? "Saved" : "Save"}
                  </Button>
                  {saveError && (
                    <p className="w-full text-xs text-destructive">{saveError}</p>
                  )}
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={handleSaveToSharePoint}>
                    <svg
                      className="h-3.5 w-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"
                      />
                    </svg>
                    Save to SharePoint
                  </Button>
                  {selectedAgent === "sow" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleShareWithShovan}
                        disabled={
                          isSharingWithShovan ||
                          !selectedAgent ||
                          output.trim().length === 0 ||
                          (isSharedWithShovan && !canReshareWithShovan)
                        }
                      >
                        {isSharingWithShovan
                          ? "Sharing…"
                          : canReshareWithShovan
                            ? "Reshare with Shovan"
                            : isSharedWithShovan
                              ? "Shared with Shovan"
                              : "Share with Shovan"}
                      </Button>
                      {shareError && (
                        <p className="w-full text-xs text-destructive">{shareError}</p>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleShareWithClient}
                        disabled={
                          isSharingWithClient ||
                          !shareId ||
                          !isShovanApproved ||
                          isSharedWithClient
                        }
                      >
                        {isSharingWithClient
                          ? "Sharing with Client..."
                          : isSharedWithClient
                            ? "Shared with Client"
                            : "Share with Client"}
                      </Button>
                      {shareWithClientError && (
                        <p className="w-full text-xs text-destructive">{shareWithClientError}</p>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* SOW Tracker — only for SOW agent */}
              {selectedAgent === "sow" && (
              <div className="rounded-lg border border-border bg-card p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">SOW Tracker</h3>
                  <span className="rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
                    {getSowTrackerItems.filter((i) => i.status === "done").length}/
                    {getSowTrackerItems.length} complete
                  </span>
                </div>

                <div className="space-y-0.5">
                  {getSowTrackerItems.map((item, idx) => (
                    <div key={item.label} className="flex items-stretch gap-3">
                      {/* Timeline spine */}
                      <div className="flex flex-col items-center">
                        <div
                          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
                            item.status === "done"
                              ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-400"
                              : item.status === "pending"
                              ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                              : "border-violet-500/30 bg-violet-500/10 text-violet-400"
                          }`}
                        >
                          {item.status === "done" ? (
                            <svg
                              className="h-3 w-3"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={2.5}
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          ) : (
                            <span>{idx + 1}</span>
                          )}
                        </div>
                        {idx < getSowTrackerItems.length - 1 && (
                          <div
                            className={`my-0.5 w-px flex-1 ${
                              item.status === "done" ? "bg-emerald-500/30" : "bg-border"
                            }`}
                          />
                        )}
                      </div>

                      {/* Row content */}
                      <div
                        className={`flex flex-1 items-center justify-between gap-2 rounded-md px-2 py-2 transition-colors hover:bg-muted/60 ${
                          idx < getSowTrackerItems.length - 1 ? "mb-0.5" : ""
                        }`}
                      >
                        <span
                          className={`text-sm ${
                            item.status === "done" ? "text-foreground" : "text-muted-foreground"
                          }`}
                        >
                          {item.label}
                        </span>
                        <TrackerStatusChip status={item.status} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/* ── Main project page ── */

export function ProjectDetail() {
  const { companyPrefix, projectId, filter } = useParams<{
    companyPrefix?: string;
    projectId: string;
    filter?: string;
  }>();
  const { companies, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { closePanel } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [fieldSaveStates, setFieldSaveStates] = useState<Partial<Record<ProjectConfigFieldKey, ProjectFieldSaveState>>>({});
  const fieldSaveRequestIds = useRef<Partial<Record<ProjectConfigFieldKey, number>>>({});
  const fieldSaveTimers = useRef<Partial<Record<ProjectConfigFieldKey, ReturnType<typeof setTimeout>>>>({});
  const routeProjectRef = projectId ?? "";
  const routeCompanyId = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix)?.id ?? null;
  }, [companies, companyPrefix]);
  const lookupCompanyId = routeCompanyId ?? selectedCompanyId ?? undefined;
  const canFetchProject = routeProjectRef.length > 0 && (isUuidLike(routeProjectRef) || Boolean(lookupCompanyId));
  const activeRouteTab = routeProjectRef ? resolveProjectTab(location.pathname, routeProjectRef) : null;
  const pluginTabFromSearch = useMemo(() => {
    const tab = new URLSearchParams(location.search).get("tab");
    return isProjectPluginTab(tab) ? tab : null;
  }, [location.search]);
  const activeTab = activeRouteTab ?? pluginTabFromSearch;

  const { data: project, isLoading, error } = useQuery({
    queryKey: [...queryKeys.projects.detail(routeProjectRef), lookupCompanyId ?? null],
    queryFn: () => projectsApi.get(routeProjectRef, lookupCompanyId),
    enabled: canFetchProject,
  });
  const canonicalProjectRef = project ? projectRouteRef(project) : routeProjectRef;
  const projectLookupRef = project?.id ?? routeProjectRef;
  const resolvedCompanyId = project?.companyId ?? selectedCompanyId;
  const experimentalSettingsQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const {
    slots: pluginDetailSlots,
    isLoading: pluginDetailSlotsLoading,
  } = usePluginSlots({
    slotTypes: ["detailTab"],
    entityType: "project",
    companyId: resolvedCompanyId,
    enabled: !!resolvedCompanyId,
  });
  const pluginTabItems = useMemo(
    () => pluginDetailSlots.map((slot) => ({
      value: `plugin:${slot.pluginKey}:${slot.id}` as ProjectPluginTab,
      label: slot.displayName,
      slot,
    })),
    [pluginDetailSlots],
  );
  const activePluginTab = pluginTabItems.find((item) => item.value === activeTab) ?? null;
  const isolatedWorkspacesEnabled = experimentalSettingsQuery.data?.enableIsolatedWorkspaces === true;
  const workspaceTabProjectId = project?.id ?? null;
  const { data: workspaceTabIssues = [], isLoading: isWorkspaceTabIssuesLoading, error: workspaceTabIssuesError } = useQuery({
    queryKey: workspaceTabProjectId && resolvedCompanyId
      ? queryKeys.issues.listByProject(resolvedCompanyId, workspaceTabProjectId)
      : ["issues", "__workspace-tab__", "disabled"],
    queryFn: () => issuesApi.list(resolvedCompanyId!, { projectId: workspaceTabProjectId! }),
    enabled: Boolean(resolvedCompanyId && workspaceTabProjectId && isolatedWorkspacesEnabled),
  });
  const {
    data: workspaceTabExecutionWorkspaces = [],
    isLoading: isWorkspaceTabExecutionWorkspacesLoading,
    error: workspaceTabExecutionWorkspacesError,
  } = useQuery({
    queryKey: workspaceTabProjectId && resolvedCompanyId
      ? queryKeys.executionWorkspaces.list(resolvedCompanyId, { projectId: workspaceTabProjectId })
      : ["execution-workspaces", "__workspace-tab__", "disabled"],
    queryFn: () => executionWorkspacesApi.list(resolvedCompanyId!, { projectId: workspaceTabProjectId! }),
    enabled: Boolean(resolvedCompanyId && workspaceTabProjectId && isolatedWorkspacesEnabled),
  });
  const workspaceSummaries = useMemo(() => {
    if (!project || !isolatedWorkspacesEnabled) return [];
    return buildProjectWorkspaceSummaries({
      project,
      issues: workspaceTabIssues,
      executionWorkspaces: workspaceTabExecutionWorkspaces,
    });
  }, [project, isolatedWorkspacesEnabled, workspaceTabIssues, workspaceTabExecutionWorkspaces]);
  const showWorkspacesTab = isolatedWorkspacesEnabled && workspaceSummaries.length > 0;
  const workspaceTabDecisionLoaded =
    experimentalSettingsQuery.isFetched &&
    (!isolatedWorkspacesEnabled || (!isWorkspaceTabIssuesLoading && !isWorkspaceTabExecutionWorkspacesLoading));
  const workspaceTabError = (workspaceTabIssuesError ?? workspaceTabExecutionWorkspacesError) as Error | null;

  useEffect(() => {
    if (!project?.companyId || project.companyId === selectedCompanyId) return;
    setSelectedCompanyId(project.companyId, { source: "route_sync" });
  }, [project?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const invalidateProject = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(routeProjectRef) });
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectLookupRef) });
    if (resolvedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(resolvedCompanyId) });
    }
  };

  const updateProject = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      projectsApi.update(projectLookupRef, data, resolvedCompanyId ?? lookupCompanyId),
    onSuccess: invalidateProject,
  });

  const archiveProject = useMutation({
    mutationFn: (archived: boolean) =>
      projectsApi.update(
        projectLookupRef,
        { archivedAt: archived ? new Date().toISOString() : null },
        resolvedCompanyId ?? lookupCompanyId,
      ),
    onSuccess: (updatedProject, archived) => {
      invalidateProject();
      const name = updatedProject?.name ?? project?.name ?? "Project";
      if (archived) {
        pushToast({ title: `"${name}" has been archived`, tone: "success" });
        navigate("/dashboard");
      } else {
        pushToast({ title: `"${name}" has been unarchived`, tone: "success" });
      }
    },
    onError: (_, archived) => {
      pushToast({
        title: archived ? "Failed to archive project" : "Failed to unarchive project",
        tone: "error",
      });
    },
  });

  const uploadImage = useMutation({
    mutationFn: async (file: File) => {
      if (!resolvedCompanyId) throw new Error("No company selected");
      return assetsApi.uploadImage(resolvedCompanyId, file, `projects/${projectLookupRef || "draft"}`);
    },
  });

  const { data: budgetOverview } = useQuery({
    queryKey: queryKeys.budgets.overview(resolvedCompanyId ?? "__none__"),
    queryFn: () => budgetsApi.overview(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
    refetchInterval: 30_000,
    staleTime: 5_000,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Projects", href: "/projects" },
      { label: project?.name ?? routeProjectRef ?? "Project" },
    ]);
  }, [setBreadcrumbs, project, routeProjectRef]);

  useEffect(() => {
    if (!project) return;
    if (routeProjectRef === canonicalProjectRef) return;
    if (isProjectPluginTab(activeTab)) {
      navigate(`/projects/${canonicalProjectRef}?tab=${encodeURIComponent(activeTab)}`, { replace: true });
      return;
    }
    if (activeTab === "overview") {
      navigate(`/projects/${canonicalProjectRef}/overview`, { replace: true });
      return;
    }
    if (activeTab === "configuration") {
      navigate(`/projects/${canonicalProjectRef}/configuration`, { replace: true });
      return;
    }
    if (activeTab === "requirement-analysis") {
      navigate(`/projects/${canonicalProjectRef}/requirement-analysis`, { replace: true });
      return;
    }
    if (activeTab === "budget") {
      navigate(`/projects/${canonicalProjectRef}/budget`, { replace: true });
      return;
    }
    if (activeTab === "plugin-operations") {
      navigate(`/projects/${canonicalProjectRef}/plugin-operations`, { replace: true });
      return;
    }
    if (activeTab === "workspaces") {
      navigate(`/projects/${canonicalProjectRef}/workspaces`, { replace: true });
      return;
    }
    if (activeTab === "list") {
      if (filter) {
        navigate(`/projects/${canonicalProjectRef}/issues/${filter}`, { replace: true });
        return;
      }
      navigate(`/projects/${canonicalProjectRef}/issues`, { replace: true });
      return;
    }
    navigate(`/projects/${canonicalProjectRef}`, { replace: true });
  }, [project, routeProjectRef, canonicalProjectRef, activeTab, filter, navigate]);

  useEffect(() => {
    closePanel();
    return () => closePanel();
  }, [closePanel]);

  useEffect(() => {
    return () => {
      Object.values(fieldSaveTimers.current).forEach((timer) => {
        if (timer) clearTimeout(timer);
      });
    };
  }, []);

  const setFieldState = useCallback((field: ProjectConfigFieldKey, state: ProjectFieldSaveState) => {
    setFieldSaveStates((current) => ({ ...current, [field]: state }));
  }, []);

  const scheduleFieldReset = useCallback((field: ProjectConfigFieldKey, delayMs: number) => {
    const existing = fieldSaveTimers.current[field];
    if (existing) clearTimeout(existing);
    fieldSaveTimers.current[field] = setTimeout(() => {
      setFieldSaveStates((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      });
      delete fieldSaveTimers.current[field];
    }, delayMs);
  }, []);

  const updateProjectField = useCallback(async (field: ProjectConfigFieldKey, data: Record<string, unknown>) => {
    const requestId = (fieldSaveRequestIds.current[field] ?? 0) + 1;
    fieldSaveRequestIds.current[field] = requestId;
    setFieldState(field, "saving");
    try {
      await projectsApi.update(projectLookupRef, data, resolvedCompanyId ?? lookupCompanyId);
      invalidateProject();
      if (fieldSaveRequestIds.current[field] !== requestId) return;
      setFieldState(field, "saved");
      scheduleFieldReset(field, 1800);
    } catch (error) {
      if (fieldSaveRequestIds.current[field] !== requestId) return;
      setFieldState(field, "error");
      scheduleFieldReset(field, 3000);
      throw error;
    }
  }, [invalidateProject, lookupCompanyId, projectLookupRef, resolvedCompanyId, scheduleFieldReset, setFieldState]);

  const projectBudgetSummary = useMemo(() => {
    const matched = budgetOverview?.policies.find(
      (policy) => policy.scopeType === "project" && policy.scopeId === (project?.id ?? routeProjectRef),
    );
    if (matched) return matched;
    return {
      policyId: "",
      companyId: resolvedCompanyId ?? "",
      scopeType: "project",
      scopeId: project?.id ?? routeProjectRef,
      scopeName: project?.name ?? "Project",
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 0,
      observedAmount: 0,
      remainingAmount: 0,
      utilizationPercent: 0,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: false,
      status: "ok",
      paused: Boolean(project?.pausedAt),
      pauseReason: project?.pauseReason ?? null,
      windowStart: new Date(),
      windowEnd: new Date(),
    } satisfies BudgetPolicySummary;
  }, [budgetOverview?.policies, project, resolvedCompanyId, routeProjectRef]);

  const budgetMutation = useMutation({
    mutationFn: (amount: number) =>
      budgetsApi.upsertPolicy(resolvedCompanyId!, {
        scopeType: "project",
        scopeId: project?.id ?? routeProjectRef,
        amount,
        windowKind: "lifetime",
      }),
    onSuccess: () => {
      if (!resolvedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets.overview(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(routeProjectRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(resolvedCompanyId) });
    },
  });

  if (pluginTabFromSearch && !pluginDetailSlotsLoading && !activePluginTab) {
    return <Navigate to={`/projects/${canonicalProjectRef}/issues`} replace />;
  }

  if (activeTab === "workspaces" && workspaceTabDecisionLoaded && !showWorkspacesTab) {
    return <Navigate to={`/projects/${canonicalProjectRef}/issues`} replace />;
  }

  // Redirect bare /projects/:id to cached tab or default /issues
  if (routeProjectRef && activeTab === null) {
    let cachedTab: string | null = null;
    if (project?.id) {
      try { cachedTab = localStorage.getItem(`paperclip:project-tab:${project.id}`); } catch {}
    }
    if (cachedTab === "overview") {
      return <Navigate to={`/projects/${canonicalProjectRef}/overview`} replace />;
    }
    if (cachedTab === "configuration") {
      return <Navigate to={`/projects/${canonicalProjectRef}/configuration`} replace />;
    }
    if (cachedTab === "requirement-analysis") {
      return <Navigate to={`/projects/${canonicalProjectRef}/requirement-analysis`} replace />;
    }
    if (cachedTab === "budget") {
      return <Navigate to={`/projects/${canonicalProjectRef}/budget`} replace />;
    }
    if (cachedTab === "plugin-operations" && project?.managedByPlugin) {
      return <Navigate to={`/projects/${canonicalProjectRef}/plugin-operations`} replace />;
    }
    if (cachedTab === "workspaces" && workspaceTabDecisionLoaded && showWorkspacesTab) {
      return <Navigate to={`/projects/${canonicalProjectRef}/workspaces`} replace />;
    }
    if (cachedTab === "workspaces" && !workspaceTabDecisionLoaded) {
      return <PageSkeleton variant="detail" />;
    }
    if (isProjectPluginTab(cachedTab)) {
      return <Navigate to={`/projects/${canonicalProjectRef}?tab=${encodeURIComponent(cachedTab)}`} replace />;
    }
    return <Navigate to={`/projects/${canonicalProjectRef}/issues`} replace />;
  }

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!project) return null;

  const handleTabChange = (tab: ProjectTab) => {
    // Cache the active tab per project
    if (project?.id) {
      try { localStorage.setItem(`paperclip:project-tab:${project.id}`, tab); } catch {}
    }
    if (isProjectPluginTab(tab)) {
      navigate(`/projects/${canonicalProjectRef}?tab=${encodeURIComponent(tab)}`);
      return;
    }
    if (tab === "overview") {
      navigate(`/projects/${canonicalProjectRef}/overview`);
    } else if (tab === "workspaces") {
      navigate(`/projects/${canonicalProjectRef}/workspaces`);
    } else if (tab === "requirement-analysis") {
      navigate(`/projects/${canonicalProjectRef}/requirement-analysis`);
    } else if (tab === "budget") {
      navigate(`/projects/${canonicalProjectRef}/budget`);
    } else if (tab === "plugin-operations") {
      navigate(`/projects/${canonicalProjectRef}/plugin-operations`);
    } else if (tab === "configuration") {
      navigate(`/projects/${canonicalProjectRef}/configuration`);
    } else {
      navigate(`/projects/${canonicalProjectRef}/issues`);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="h-7 flex items-center">
          <ColorPicker
            currentColor={project.color ?? "#6366f1"}
            onSelect={(color) => updateProject.mutate({ color })}
          />
        </div>
        <div className="min-w-0 space-y-2">
          <InlineEditor
            value={project.name}
            onSave={(name) => updateProject.mutate({ name })}
            as="h2"
            className="text-xl font-bold"
          />
          {project.pauseReason === "budget" ? (
            <div className="inline-flex items-center gap-2 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-red-200">
              <span className="h-2 w-2 rounded-full bg-red-400" />
              Paused by budget hard stop
            </div>
          ) : null}
          {project.managedByPlugin ? (
            <div className="inline-flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1 text-[11px] font-medium text-muted-foreground">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: project.color ?? "#6366f1" }} />
              Managed by {project.managedByPlugin.pluginDisplayName}
            </div>
          ) : null}
        </div>
      </div>

      <PluginSlotOutlet
        slotTypes={["toolbarButton", "contextMenuItem"]}
        entityType="project"
        context={{
          companyId: resolvedCompanyId ?? null,
          companyPrefix: companyPrefix ?? null,
          projectId: project.id,
          projectRef: canonicalProjectRef,
          entityId: project.id,
          entityType: "project",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
        missingBehavior="placeholder"
      />

      <PluginLauncherOutlet
        placementZones={["toolbarButton"]}
        entityType="project"
        context={{
          companyId: resolvedCompanyId ?? null,
          companyPrefix: companyPrefix ?? null,
          projectId: project.id,
          projectRef: canonicalProjectRef,
          entityId: project.id,
          entityType: "project",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
      />

      <Tabs value={activeTab ?? "list"} onValueChange={(value) => handleTabChange(value as ProjectTab)}>
        <PageTabBar
          items={[
            { value: "list", label: "Issues" },
            { value: "overview", label: "Overview" },
            ...(project.managedByPlugin ? [{ value: "plugin-operations", label: "Plugin operations" }] : []),
            ...(showWorkspacesTab ? [{ value: "workspaces", label: "Workspaces" }] : []),
            { value: "configuration", label: "Configuration" },
            { value: "requirement-analysis", label: "Requirement Analysis" },
            { value: "budget", label: "Budget" },
            ...pluginTabItems.map((item) => ({
              value: item.value,
              label: item.label,
            })),
          ]}
          align="start"
          value={activeTab ?? "list"}
          onValueChange={(value) => handleTabChange(value as ProjectTab)}
        />
      </Tabs>

      {activeTab === "overview" && (
        <OverviewContent
          project={project}
          onUpdate={(data) => updateProject.mutate(data)}
          imageUploadHandler={async (file) => {
            const asset = await uploadImage.mutateAsync(file);
            return asset.contentPath;
          }}
        />
      )}

      {activeTab === "list" && project?.id && resolvedCompanyId && (
        <ProjectIssuesList projectId={project.id} companyId={resolvedCompanyId} />
      )}

      {activeTab === "plugin-operations" && project?.id && resolvedCompanyId && project.managedByPlugin && (
        <ProjectPluginOperationsList
          projectId={project.id}
          companyId={resolvedCompanyId}
          pluginKey={project.managedByPlugin.pluginKey}
        />
      )}

      {activeTab === "workspaces" ? (
        workspaceTabDecisionLoaded ? (
          workspaceTabError ? (
            <p className="text-sm text-destructive">{workspaceTabError.message}</p>
          ) : (
            <ProjectWorkspacesContent
              companyId={resolvedCompanyId!}
              projectId={project.id}
              projectRef={canonicalProjectRef}
              summaries={workspaceSummaries}
            />
          )
        ) : (
          <p className="text-sm text-muted-foreground">Loading workspaces...</p>
        )
      ) : null}

      {activeTab === "configuration" && (
        <div className="max-w-4xl">
          <ProjectProperties
            project={project}
            onUpdate={(data) => updateProject.mutate(data)}
            onFieldUpdate={updateProjectField}
            getFieldSaveState={(field) => fieldSaveStates[field] ?? "idle"}
            onArchive={(archived) => archiveProject.mutate(archived)}
            archivePending={archiveProject.isPending}
          />
        </div>
      )}

      {activeTab === "requirement-analysis" ? (
        <RequirementAnalysisWorkspace
          projectId={project.id}
          companyId={resolvedCompanyId ?? undefined}
        />
      ) : null}

      {activeTab === "budget" && resolvedCompanyId ? (
        <div className="max-w-3xl">
          <BudgetPolicyCard
            summary={projectBudgetSummary}
            variant="plain"
            isSaving={budgetMutation.isPending}
            onSave={(amount) => budgetMutation.mutate(amount)}
          />
        </div>
      ) : null}

      {activePluginTab && (
        <PluginSlotMount
          slot={activePluginTab.slot}
          context={{
            companyId: resolvedCompanyId,
            companyPrefix: companyPrefix ?? null,
            projectId: project.id,
            projectRef: canonicalProjectRef,
            entityId: project.id,
            entityType: "project",
          }}
          missingBehavior="placeholder"
        />
      )}
    </div>
  );
}
