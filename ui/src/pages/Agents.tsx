import { useState, useEffect, useMemo } from "react";
import { Link, useNavigate, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { accessApi, type EmployeeRecord } from "../api/access";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { agentStatusDot, agentStatusDotDefault } from "../lib/status-colors";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { relativeTime, cn, agentRouteRef, agentUrl } from "../lib/utils";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Bot, Plus, List, GitBranch, SlidersHorizontal, UserRound } from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent } from "@paperclipai/shared";

import { getAdapterLabel } from "../adapters/adapter-display-registry";

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

type FilterTab = "all" | "active" | "paused" | "error";

function matchesFilter(status: string, tab: FilterTab, showTerminated: boolean): boolean {
  if (status === "terminated") return showTerminated;
  if (tab === "all") return true;
  if (tab === "active") return status === "active" || status === "running" || status === "idle";
  if (tab === "paused") return status === "paused";
  if (tab === "error") return status === "error";
  return true;
}

function filterAgents(agents: Agent[], tab: FilterTab, showTerminated: boolean): Agent[] {
  return agents
    .filter((a) => matchesFilter(a.status, tab, showTerminated))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function filterEmployees(employees: EmployeeRecord[], tab: FilterTab): EmployeeRecord[] {
  return employees
    .filter((employee) => {
      if (tab === "all") return true;
      if (tab === "active") return employee.workforceStatus === "active";
      if (tab === "paused") return employee.workforceStatus === "suspended";
      if (tab === "error") return false;
      return true;
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function getEmployeeStatusLabel(employee: EmployeeRecord): string {
  if (employee.workforceStatus === "active") return "active";
  if (employee.workforceStatus === "suspended") return "suspended";
  if (employee.workforceStatus === "pending_acceptance") return "awaiting approval";
  return "invited";
}

function getEmployeeStatusClass(employee: EmployeeRecord): string {
  if (employee.workforceStatus === "active") return "bg-emerald-500/10 text-emerald-300 border-emerald-500/20";
  if (employee.workforceStatus === "suspended") return "bg-red-500/10 text-red-300 border-red-500/20";
  return "bg-amber-500/10 text-amber-200 border-amber-500/20";
}

function getConfiguredModel(agent: Agent): string | null {
  const value = agent.adapterConfig?.model;
  if (typeof value !== "string") return null;
  const model = value.trim();
  return model.length > 0 ? model : null;
}

type EmployeeOrgNode = {
  id: string;
  name: string;
  role: string;
  workforceStatus: EmployeeRecord["workforceStatus"];
  reports: EmployeeOrgNode[];
};

function matchesEmployeeOrgFilter(status: EmployeeRecord["workforceStatus"], tab: FilterTab): boolean {
  if (tab === "all") return true;
  if (tab === "active") return status === "active";
  if (tab === "paused") return status === "suspended";
  if (tab === "error") return false;
  return true;
}

function employeeOrgRole(employee: EmployeeRecord): string {
  if (employee.workspaceRole === "owner") return "CEO";
  const explicitRole = employee.role.trim();
  if (explicitRole) return explicitRole;
  if (employee.workspaceRole) return employee.workspaceRole;
  return "Member";
}

function buildEmployeeOrgTree(employees: EmployeeRecord[]): EmployeeOrgNode[] {
  const activeEmployees = employees.filter((employee) => employee.membershipStatus !== "archived");
  const byMembershipId = new Map(activeEmployees.map((employee) => [employee.membershipId, employee]));
  const reportsByManager = new Map<string, EmployeeRecord[]>();

  const isOwner = (employee: EmployeeRecord) => employee.workspaceRole === "owner";

  for (const employee of activeEmployees) {
    if (isOwner(employee)) continue;
    const managerMembershipId = employee.manager?.type === "employee"
      ? employee.manager.membershipId ?? null
      : null;
    if (!managerMembershipId || !byMembershipId.has(managerMembershipId)) continue;
    const current = reportsByManager.get(managerMembershipId) ?? [];
    current.push(employee);
    reportsByManager.set(managerMembershipId, current);
  }

  const roots = activeEmployees.filter((employee) => {
    if (isOwner(employee)) return true;
    const managerMembershipId = employee.manager?.type === "employee"
      ? employee.manager.membershipId ?? null
      : null;
    return !managerMembershipId || !byMembershipId.has(managerMembershipId);
  });

  const visited = new Set<string>();
  const toNode = (employee: EmployeeRecord): EmployeeOrgNode => {
    if (visited.has(employee.membershipId)) {
      return {
        id: employee.id,
        name: employee.displayName,
        role: employeeOrgRole(employee),
        workforceStatus: employee.workforceStatus,
        reports: [],
      };
    }
    visited.add(employee.membershipId);
    const reports = (reportsByManager.get(employee.membershipId) ?? [])
      .slice()
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map(toNode);
    return {
      id: employee.id,
      name: employee.displayName,
      role: employeeOrgRole(employee),
      workforceStatus: employee.workforceStatus,
      reports,
    };
  };

  const orderedRoots = roots
    .slice()
    .sort((a, b) => {
      if (a.workspaceRole === "owner" && b.workspaceRole !== "owner") return -1;
      if (b.workspaceRole === "owner" && a.workspaceRole !== "owner") return 1;
      return a.displayName.localeCompare(b.displayName);
    });

  const tree = orderedRoots.map(toNode);
  const unvisitedRoots = activeEmployees
    .filter((employee) => !visited.has(employee.membershipId))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  for (const employee of unvisitedRoots) {
    tree.push(toNode(employee));
  }

  return tree;
}

function filterEmployeeOrgTree(nodes: EmployeeOrgNode[], tab: FilterTab): EmployeeOrgNode[] {
  return nodes
    .reduce<EmployeeOrgNode[]>((acc, node) => {
      const filteredReports = filterEmployeeOrgTree(node.reports, tab);
      if (matchesEmployeeOrgFilter(node.workforceStatus, tab) || filteredReports.length > 0) {
        acc.push({ ...node, reports: filteredReports });
      }
      return acc;
    }, [])
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function Agents() {
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile } = useSidebar();
  const pathSegment = location.pathname.split("/").pop() ?? "all";
  const tab: FilterTab = (pathSegment === "all" || pathSegment === "active" || pathSegment === "paused" || pathSegment === "error") ? pathSegment : "all";
  const [view, setView] = useState<"list" | "org">("org");
  const forceListView = isMobile;
  const effectiveView: "list" | "org" = forceListView ? "list" : view;
  const [showTerminated, setShowTerminated] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const { data: agents, isLoading, error } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: employeesResponse } = useQuery({
    queryKey: queryKeys.access.employees(selectedCompanyId!),
    queryFn: () => accessApi.listEmployees(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: runs } = useQuery({
    queryKey: [...queryKeys.liveRuns(selectedCompanyId!), "agents-page"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  // Map agentId -> first live run + live run count
  const liveRunByAgent = useMemo(() => {
    const map = new Map<string, { runId: string; liveCount: number }>();
    for (const r of runs ?? []) {
      if (r.status !== "running" && r.status !== "queued") continue;
      const existing = map.get(r.agentId);
      if (existing) {
        existing.liveCount += 1;
        continue;
      }
      map.set(r.agentId, { runId: r.id, liveCount: 1 });
    }
    return map;
  }, [runs]);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Agents" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Bot} message="Select a company to view agents." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const filtered = filterAgents(agents ?? [], tab, showTerminated);
  const filteredEmployees = filterEmployees(employeesResponse?.employees ?? [], tab);
  const employeeOrgTree = buildEmployeeOrgTree(employeesResponse?.employees ?? []);
  const filteredOrg = filterEmployeeOrgTree(employeeOrgTree, tab);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={tab} onValueChange={(v) => navigate(`/agents/${v}`)}>
          <PageTabBar
            items={[
              { value: "all", label: "All" },
              { value: "active", label: "Active" },
              { value: "paused", label: "Paused" },
              { value: "error", label: "Error" },
            ]}
            value={tab}
            onValueChange={(v) => navigate(`/agents/${v}`)}
          />
        </Tabs>
        <div className="flex items-center gap-2">
          {/* Filters */}
          <div className="relative">
            <button
              className={cn(
                "flex items-center gap-1.5 px-2 py-1.5 text-xs transition-colors border border-border",
                filtersOpen || showTerminated ? "text-foreground bg-accent" : "text-muted-foreground hover:bg-accent/50"
              )}
              onClick={() => setFiltersOpen(!filtersOpen)}
            >
              <SlidersHorizontal className="h-3 w-3" />
              Filters
              {showTerminated && <span className="ml-0.5 px-1 bg-foreground/10 rounded text-[10px]">1</span>}
            </button>
            {filtersOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 w-48 border border-border bg-popover shadow-md p-1">
                <button
                  className="flex items-center gap-2 w-full px-2 py-1.5 text-xs text-left hover:bg-accent/50 transition-colors"
                  onClick={() => setShowTerminated(!showTerminated)}
                >
                  <span className={cn(
                    "flex items-center justify-center h-3.5 w-3.5 border border-border rounded-sm",
                    showTerminated && "bg-foreground"
                  )}>
                    {showTerminated && <span className="text-background text-[10px] leading-none">&#10003;</span>}
                  </span>
                  Show terminated
                </button>
              </div>
            )}
          </div>
          {/* View toggle */}
          {!forceListView && (
            <div className="flex items-center border border-border">
              <button
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "list" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => setView("list")}
              >
                <List className="h-3.5 w-3.5" />
              </button>
              <button
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "org" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => setView("org")}
              >
                <GitBranch className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <Button size="sm" variant="outline" onClick={openNewAgent}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New Agent
          </Button>
        </div>
      </div>

      {(filtered.length > 0 || filteredEmployees.length > 0) && (
        <p className="text-xs text-muted-foreground">
          {filtered.length} agent{filtered.length !== 1 ? "s" : ""} • {filteredEmployees.length} human{filteredEmployees.length !== 1 ? "s" : ""}
        </p>
      )}

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {agents && agents.length === 0 && filteredEmployees.length === 0 && (
        <EmptyState
          icon={Bot}
          message="Create your first agent to get started."
          action="New Agent"
          onAction={openNewAgent}
        />
      )}

      {/* List view */}
      {effectiveView === "list" && filtered.length > 0 && (
        <div className="border border-border">
          {filtered.map((agent) => {
            return (
              <EntityRow
                key={agent.id}
                title={agent.name}
                subtitle={`${roleLabels[agent.role] ?? agent.role}${agent.title ? ` - ${agent.title}` : ""}`}
                to={agentUrl(agent)}
                className={agent.pausedAt && tab !== "paused" ? "opacity-50" : ""}
                leading={
                  <span className="relative flex h-2.5 w-2.5">
                    <span
                      className={`absolute inline-flex h-full w-full rounded-full ${agentStatusDot[agent.status] ?? agentStatusDotDefault}`}
                    />
                  </span>
                }
                trailing={
                  <div className="flex items-center gap-3">
                    <span className="sm:hidden">
                      {liveRunByAgent.has(agent.id) ? (
                        <LiveRunIndicator
                          agentRef={agentRouteRef(agent)}
                          runId={liveRunByAgent.get(agent.id)!.runId}
                          liveCount={liveRunByAgent.get(agent.id)!.liveCount}
                        />
                      ) : (
                        <StatusBadge status={agent.status} />
                      )}
                    </span>
                    <div className="hidden sm:flex items-center gap-3">
                      {liveRunByAgent.has(agent.id) && (
                        <LiveRunIndicator
                          agentRef={agentRouteRef(agent)}
                          runId={liveRunByAgent.get(agent.id)!.runId}
                          liveCount={liveRunByAgent.get(agent.id)!.liveCount}
                        />
                      )}
                      <span className="w-28 whitespace-nowrap text-left font-mono text-xs text-muted-foreground">
                        {getAdapterLabel(agent.adapterType)}
                      </span>
                      <span
                        className="w-36 truncate text-left font-mono text-xs text-muted-foreground"
                        title={getConfiguredModel(agent) ?? undefined}
                      >
                        {getConfiguredModel(agent) ?? "—"}
                      </span>
                      <span className="text-xs text-muted-foreground w-16 text-right">
                        {agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "—"}
                      </span>
                      <span className="w-20 flex justify-end">
                        <StatusBadge status={agent.status} />
                      </span>
                    </div>
                  </div>
                }
              />
            );
          })}
        </div>
      )}

      {effectiveView === "list" && filteredEmployees.length > 0 && (
        <div className="border border-border">
          <div className="border-b border-border px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Humans
          </div>
          {filteredEmployees.map((employee) => (
            <EntityRow
              key={employee.id}
              title={employee.displayName}
              subtitle={`${employee.role}${employee.department ? ` • ${employee.department}` : ""}${employee.personalAgent ? ` • AI ${employee.personalAgent.name}` : ""}`}
              leading={<UserRound className="h-4 w-4 text-muted-foreground" />}
              trailing={
                <div className="flex items-center gap-3">
                  <span className="hidden sm:block w-36 truncate text-left text-xs text-muted-foreground">
                    {employee.manager?.displayName ? `Manager: ${employee.manager.displayName}` : "No manager"}
                  </span>
                  <span className="hidden sm:block w-28 truncate text-left text-xs text-muted-foreground">
                    {employee.personalAgent?.status ?? "no assistant"}
                  </span>
                  <span className={cn("rounded-full border px-2 py-0.5 text-xs capitalize", getEmployeeStatusClass(employee))}>
                    {getEmployeeStatusLabel(employee)}
                  </span>
                </div>
              }
            />
          ))}
        </div>
      )}

      {effectiveView === "list" && agents && agents.length > 0 && filtered.length === 0 && filteredEmployees.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No agents or humans match the selected filter.
        </p>
      )}

      {/* Org chart view */}
      {effectiveView === "org" && filteredOrg.length > 0 && (
        <div className="border border-border py-1">
          {filteredOrg.map((node) => (
            <EmployeeOrgTreeNode key={node.id} node={node} depth={0} />
          ))}
        </div>
      )}

      {effectiveView === "org" && employeeOrgTree.length > 0 && filteredOrg.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No users match the selected filter.
        </p>
      )}

      {effectiveView === "org" && employeeOrgTree.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No organizational hierarchy defined.
        </p>
      )}
    </div>
  );
}

function EmployeeOrgTreeNode({
  node,
  depth,
}: {
  node: EmployeeOrgNode;
  depth: number;
}) {
  const statusColor = node.workforceStatus === "active"
    ? "bg-green-400"
    : node.workforceStatus === "suspended"
      ? "bg-red-400"
      : "bg-amber-400";

  return (
    <div style={{ paddingLeft: depth * 24 }}>
      <div className="flex items-center gap-3 px-3 py-2 hover:bg-accent/30 transition-colors w-full text-left">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className={`absolute inline-flex h-full w-full rounded-full ${statusColor}`} />
        </span>
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium">{node.name}</span>
          <span className="text-xs text-muted-foreground ml-2">
            {node.role}
          </span>
        </div>
        <span className="w-20 flex justify-end">
          <span className="rounded-full border px-2 py-0.5 text-xs capitalize text-muted-foreground">
            {node.workforceStatus === "pending_acceptance" ? "awaiting approval" : node.workforceStatus}
          </span>
        </span>
      </div>
      {node.reports && node.reports.length > 0 && (
        <div className="border-l border-border/50 ml-4">
          {node.reports.map((child) => (
            <EmployeeOrgTreeNode key={child.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function LiveRunIndicator({
  agentRef,
  runId,
  liveCount,
}: {
  agentRef: string;
  runId: string;
  liveCount: number;
}) {
  return (
    <Link
      to={`/agents/${agentRef}/runs/${runId}`}
      className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/10 hover:bg-blue-500/20 transition-colors no-underline"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="relative flex h-2 w-2">
        <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
      </span>
      <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">
        Live{liveCount > 1 ? ` (${liveCount})` : ""}
      </span>
    </Link>
  );
}
