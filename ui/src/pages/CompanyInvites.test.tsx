// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyInvites } from "./CompanyInvites";
import { queryKeys } from "@/lib/queryKeys";

const listInvitesMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());
const createCompanyInviteMock = vi.hoisted(() => vi.fn());
const createEmployeeMock = vi.hoisted(() => vi.fn());
const revokeInviteMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const clipboardWriteTextMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/access", () => ({
  accessApi: {
    listInvites: (companyId: string, options?: unknown) => listInvitesMock(companyId, options),
    createCompanyInvite: (companyId: string, input: unknown) =>
      createCompanyInviteMock(companyId, input),
    createEmployee: (companyId: string, input: unknown) =>
      createEmployeeMock(companyId, input),
    revokeInvite: (inviteId: string) => revokeInviteMock(inviteId),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: (companyId: string) => listAgentsMock(companyId),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function setNativeInputValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  descriptor?.set?.call(element, value);
}

describe("CompanyInvites", () => {
  let container: HTMLDivElement;
  const inviteHistory = Array.from({ length: 25 }, (_, index) => {
    const inviteNumber = 25 - index;
    const isActive = inviteNumber === 25;
    return {
      id: `invite-${inviteNumber}`,
      companyId: "company-1",
      inviteType: "company_join",
      tokenHash: `hash-${inviteNumber}`,
      allowedJoinTypes: "human",
      defaultsPayload: null,
      expiresAt: "2026-04-20T00:00:00.000Z",
      invitedByUserId: "user-1",
      revokedAt: null,
      acceptedAt: isActive ? null : "2026-04-11T00:00:00.000Z",
      createdAt: `2026-04-${String(inviteNumber).padStart(2, "0")}T00:00:00.000Z`,
      updatedAt: `2026-04-${String(inviteNumber).padStart(2, "0")}T00:00:00.000Z`,
      companyName: "Paperclip",
      humanRole: isActive ? "operator" : "viewer",
      inviteMessage: null,
      state: isActive ? "active" : "accepted",
      invitedByUser: {
        id: "user-1",
        name: `Board User ${inviteNumber}`,
        email: `board${inviteNumber}@paperclip.local`,
        image: null,
      },
      relatedJoinRequestId: isActive ? "join-1" : null,
    };
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    listInvitesMock.mockImplementation((_companyId: string, options?: { limit?: number; offset?: number }) => {
      const limit = options?.limit ?? 20;
      const offset = options?.offset ?? 0;
      const invites = inviteHistory.slice(offset, offset + limit);
      const nextOffset = offset + invites.length < inviteHistory.length ? offset + invites.length : null;
      return Promise.resolve({ invites, nextOffset });
    });

    createCompanyInviteMock.mockResolvedValue({
      inviteUrl: "https://paperclip.local/invite/new-token",
      onboardingTextUrl: null,
      onboardingTextPath: null,
      humanRole: "viewer",
      allowedJoinTypes: "human",
    });

    listAgentsMock.mockResolvedValue([
      {
        id: "agent-1",
        name: "CEO",
        role: "ceo",
      },
    ]);

    createEmployeeMock.mockResolvedValue({
      employee: {
        invitation: {
          inviteUrl: "https://paperclip.local/invite/employee-token",
        },
      },
    });

    revokeInviteMock.mockResolvedValue(undefined);

    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteTextMock },
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders a human-only invite flow and keeps invite history in a table", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <CompanyInvites />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Company Invites");
    expect(container.textContent).toContain("Create invite");
    expect(container.textContent).toContain("Create linked personal AI assistant");
    expect(container.textContent).toContain("Invite history");
    expect(container.textContent).toContain("personal AI assistant too");
    expect(container.textContent).toContain("Access");
    expect(container.textContent).toContain("Board User 25");
    expect(container.textContent).toContain("Board User 21");
    expect(container.textContent).not.toContain("Board User 20");
    expect(container.textContent).toContain("Review request");
    expect(container.textContent).toContain("View more");
    expect(container.textContent).not.toContain("Human or agent");
    expect(container.textContent).not.toContain("Invite message");
    expect(container.textContent).not.toContain("Latest generated invite");
    expect(container.textContent).not.toContain("Active invites");
    expect(container.textContent).not.toContain("Consumed invites");
    expect(container.textContent).not.toContain("Expired invites");
    expect(container.textContent).not.toContain("OpenClaw shortcut");

    expect(container.textContent).toContain("Choose a role");
    expect(container.textContent).toContain("Each invite link is single-use.");
    expect(container.textContent).toContain("Can create agents, invite users, assign tasks, and approve join requests.");
    expect(container.textContent).toContain("Everything in Admin, plus managing members and permission grants.");
    expect(listInvitesMock).toHaveBeenCalledWith("company-1", { limit: 5, offset: 0 });

    const viewMoreButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "View more",
    );

    await act(async () => {
      viewMoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(listInvitesMock).toHaveBeenCalledWith("company-1", { limit: 5, offset: 5 });
    expect(container.textContent).toContain("Board User 20");
    expect(container.textContent).toContain("Board User 16");
    expect(container.textContent).toContain("View more");

    await act(async () => {
      const viewerRadio = container.querySelector('input[type="radio"][value="viewer"]') as HTMLInputElement | null;
      viewerRadio?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      viewerRadio?.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    const createButton = buttons.find((button) => button.textContent === "Create invite");
    const revokeButton = buttons.find((button) => button.textContent === "Revoke");

    expect(createButton).toBeTruthy();
    expect(revokeButton).toBeTruthy();

    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(createCompanyInviteMock).toHaveBeenCalledWith("company-1", {
      allowedJoinTypes: "human",
      humanRole: "viewer",
      agentMessage: null,
    });
    expect(clipboardWriteTextMock).toHaveBeenCalledWith("https://paperclip.local/invite/new-token");
    expect(container.textContent).toContain("Latest invite link");
    expect(container.textContent).toContain("This URL includes the current Paperclip domain returned by the server.");
    expect(container.textContent).toContain("https://paperclip.local/invite/new-token");
    expect(container.textContent).toContain("Open invite");
    expect(pushToastMock).toHaveBeenCalledWith({
      title: "Invite created",
      body: "Invite ready below and copied to clipboard.",
      tone: "success",
    });

    const inviteFieldButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("https://paperclip.local/invite/new-token"),
    );

    await act(async () => {
      inviteFieldButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(clipboardWriteTextMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Copied");

    await act(async () => {
      revokeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(revokeInviteMock).toHaveBeenCalledWith("invite-25");

    await act(async () => {
      root.unmount();
    });
  });

  it("can create an employee invite with a linked personal AI assistant from the invites page", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <CompanyInvites />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();

    const assistantToggle = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;

    await act(async () => {
      assistantToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      assistantToggle?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(listAgentsMock).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("Assistant setup");
    expect(container.textContent).toContain("Create invite and agent");

    const nameInput = Array.from(container.querySelectorAll("input")).find(
      (input) => (input as HTMLInputElement).placeholder === "Jordan Lee",
    ) as HTMLInputElement | undefined;
    const emailInput = Array.from(container.querySelectorAll('input[type="email"]')).find(
      (input) => (input as HTMLInputElement).placeholder === "jordan@example.com",
    ) as HTMLInputElement | undefined;
    const roleInput = Array.from(container.querySelectorAll("input")).find(
      (input) => (input as HTMLInputElement).placeholder === "Product designer",
    ) as HTMLInputElement | undefined;
    const departmentInput = Array.from(container.querySelectorAll("input")).find(
      (input) => (input as HTMLInputElement).placeholder === "Design",
    ) as HTMLInputElement | undefined;
    const selects = Array.from(container.querySelectorAll("select")) as HTMLSelectElement[];
    const experienceSelect = selects[0];
    const managerSelect = selects[1];

    await act(async () => {
      if (nameInput) {
        setNativeInputValue(nameInput, "Jordan Lee");
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
        nameInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (emailInput) {
        setNativeInputValue(emailInput, "jordan@example.com");
        emailInput.dispatchEvent(new Event("input", { bubbles: true }));
        emailInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (roleInput) {
        setNativeInputValue(roleInput, "Product designer");
        roleInput.dispatchEvent(new Event("input", { bubbles: true }));
        roleInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (departmentInput) {
        setNativeInputValue(departmentInput, "Design");
        departmentInput.dispatchEvent(new Event("input", { bubbles: true }));
        departmentInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (experienceSelect) {
        setNativeInputValue(experienceSelect, "senior");
        experienceSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (managerSelect) {
        setNativeInputValue(managerSelect, "agent-1");
        managerSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await flushReact();

    const createButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Create invite and agent",
    );

    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(createEmployeeMock).toHaveBeenCalledWith("company-1", {
      displayName: "Jordan Lee",
      email: "jordan@example.com",
      workspaceRole: "operator",
      role: "Product designer",
      department: "Design",
      experienceLevel: "senior",
      manager: { type: "agent", agentId: "agent-1" },
    });
    expect(clipboardWriteTextMock).toHaveBeenCalledWith("https://paperclip.local/invite/employee-token");
    expect(container.textContent).toContain("https://paperclip.local/invite/employee-token");
    expect(pushToastMock).toHaveBeenCalledWith({
      title: "Employee invite created",
      body: "Invite with linked personal AI assistant is ready below and copied to clipboard.",
      tone: "success",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("ignores legacy cached invite arrays and refetches paginated history", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["access", "invites", "company-1", "all"], inviteHistory.slice(0, 2));

    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <CompanyInvites />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Board User 25");
    expect(container.textContent).not.toContain("Board User 20");
    expect(listInvitesMock).toHaveBeenCalledWith("company-1", { limit: 5, offset: 0 });
    expect(queryClient.getQueryData(queryKeys.access.invites("company-1", "all", 5))).toMatchObject({
      pages: [
        {
          invites: expect.any(Array),
          nextOffset: 5,
        },
      ],
    });

    await act(async () => {
      root.unmount();
    });
  });
});
