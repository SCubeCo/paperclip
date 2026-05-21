import { describe, expect, it, vi } from "vitest";
import { syncEmployeeMembershipState } from "../routes/access.js";

function createDbStub(selectResults: unknown[]) {
  const pendingSelects = [...selectResults];
  const updateSetMock = vi.fn();
  const insertValuesMock = vi.fn();

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(pendingSelects.shift() ?? [])),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((value) => {
        updateSetMock(value);
        return {
          where: vi.fn(() => Promise.resolve(undefined)),
        };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((value) => {
        insertValuesMock(value);
        return Promise.resolve(undefined);
      }),
    })),
  };

  return { db, updateSetMock, insertValuesMock };
}

describe("syncEmployeeMembershipState", () => {
  it("creates and links a missing personal agent for an active employee membership", async () => {
    const { db, updateSetMock, insertValuesMock } = createDbStub([
      [
        {
          id: "membership-1",
          companyId: "company-1",
          principalType: "user",
          principalId: "user-1",
          status: "active",
        },
      ],
      [
        {
          id: "profile-1",
          companyId: "company-1",
          membershipId: "membership-1",
          displayName: "",
          email: "existing.user@example.com",
          role: "Designer",
          department: "Design",
          availabilityStatus: "pending_acceptance",
          metadata: {
            manager: {
              type: "agent",
              agentId: "manager-agent-1",
              displayName: "CEO",
            },
          },
        },
      ],
      [],
      [
        {
          permissionKey: "tasks:assign",
          scope: null,
        },
      ],
    ]);

    const access = {
      ensureMembership: vi.fn(() => Promise.resolve(undefined)),
      setPrincipalGrants: vi.fn(() => Promise.resolve(undefined)),
    };
    const agents = {
      getById: vi.fn((id: string) => {
        if (id === "manager-agent-1") {
          return Promise.resolve({
            id,
            companyId: "company-1",
            name: "CEO",
            status: "active",
            pauseReason: null,
          });
        }
        if (id === "agent-new") {
          return Promise.resolve({
            id,
            companyId: "company-1",
            name: "existing.user Assistant",
            status: "paused",
            pauseReason: "system",
          });
        }
        return Promise.resolve(null);
      }),
      create: vi.fn(() =>
        Promise.resolve({
          id: "agent-new",
          companyId: "company-1",
        }),
      ),
      resume: vi.fn(() => Promise.resolve(undefined)),
      pause: vi.fn(() => Promise.resolve(undefined)),
      terminate: vi.fn(() => Promise.resolve(undefined)),
    };

    await syncEmployeeMembershipState(
      db as never,
      access as never,
      agents as never,
      "company-1",
      "membership-1",
      "board-user-1",
    );

    expect(agents.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        name: "existing.user Assistant",
        title: "Designer AI Assistant",
        reportsTo: "manager-agent-1",
        capabilities: expect.stringContaining("role Designer"),
        metadata: expect.objectContaining({
          employeeAssistant: true,
          invitedEmail: "existing.user@example.com",
        }),
      }),
    );
    expect(access.ensureMembership).toHaveBeenCalledWith(
      "company-1",
      "agent",
      "agent-new",
      "member",
      "active",
    );
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        membershipId: "membership-1",
        agentId: "agent-new",
        relationType: "assistant",
        isPrimary: true,
      }),
    );
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ availabilityStatus: "available" }),
    );
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ personalAgentId: "agent-new" }),
      }),
    );
    expect(access.setPrincipalGrants).toHaveBeenCalledWith(
      "company-1",
      "agent",
      "agent-new",
      [{ permissionKey: "tasks:assign", scope: null }],
      "board-user-1",
    );
    expect(agents.resume).toHaveBeenCalledWith("agent-new");
  });

  it("relinks owner memberships to the CEO without syncing employee assistant state onto that agent", async () => {
    const { db, updateSetMock, insertValuesMock } = createDbStub([
      [
        {
          id: "membership-owner-1",
          companyId: "company-1",
          principalType: "user",
          principalId: "owner-user-1",
          membershipRole: "owner",
          status: "active",
        },
      ],
      [
        {
          id: "profile-owner-1",
          companyId: "company-1",
          membershipId: "membership-owner-1",
          displayName: "Owner User",
          email: "owner@example.com",
          role: "Founder",
          department: "Leadership",
          availabilityStatus: "pending_acceptance",
          metadata: {},
        },
      ],
      [{ agentId: "assistant-agent-1" }],
      [
        {
          id: "ceo-agent-1",
          name: "CEO",
          role: "ceo",
          status: "active",
          reportsTo: null,
        },
      ],
      [
        {
          permissionKey: "tasks:assign",
          scope: null,
        },
      ],
    ]);

    const access = {
      ensureMembership: vi.fn(() => Promise.resolve(undefined)),
      setPrincipalGrants: vi.fn(() => Promise.resolve(undefined)),
    };
    const agents = {
      getById: vi.fn((id: string) => {
        if (id === "ceo-agent-1") {
          return Promise.resolve({
            id,
            companyId: "company-1",
            name: "CEO",
            role: "ceo",
            status: "active",
            pauseReason: null,
          });
        }
        return Promise.resolve(null);
      }),
      create: vi.fn(() => Promise.resolve({ id: "unused-agent", companyId: "company-1" })),
      resume: vi.fn(() => Promise.resolve(undefined)),
      pause: vi.fn(() => Promise.resolve(undefined)),
      terminate: vi.fn(() => Promise.resolve(undefined)),
    };

    await syncEmployeeMembershipState(
      db as never,
      access as never,
      agents as never,
      "company-1",
      "membership-owner-1",
      "board-user-1",
    );

    expect(agents.create).not.toHaveBeenCalled();
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        membershipId: "membership-owner-1",
        agentId: "ceo-agent-1",
        relationType: "assistant",
        isPrimary: true,
      }),
    );
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ availabilityStatus: "available" }),
    );
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ isPrimary: false }),
    );
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ personalAgentId: "ceo-agent-1" }),
      }),
    );
    expect(access.setPrincipalGrants).not.toHaveBeenCalled();
    expect(access.ensureMembership).not.toHaveBeenCalled();
    expect(agents.resume).not.toHaveBeenCalled();
    expect(agents.pause).not.toHaveBeenCalled();
  });

  it("terminates linked personal agents when a membership is archived", async () => {
    const { db, updateSetMock } = createDbStub([
      [
        {
          id: "membership-2",
          companyId: "company-1",
          principalType: "user",
          principalId: "user-2",
          membershipRole: "operator",
          status: "archived",
        },
      ],
      [
        {
          id: "profile-2",
          companyId: "company-1",
          membershipId: "membership-2",
          displayName: "Archived User",
          email: "archived.user@example.com",
          role: "Engineer",
          department: "Engineering",
          availabilityStatus: "available",
          metadata: { personalAgentId: "assistant-agent-2" },
        },
      ],
      [{ agentId: "assistant-agent-2" }],
    ]);

    const access = {
      ensureMembership: vi.fn(() => Promise.resolve(undefined)),
      setPrincipalGrants: vi.fn(() => Promise.resolve(undefined)),
    };
    const agents = {
      getById: vi.fn((id: string) => {
        if (id === "assistant-agent-2") {
          return Promise.resolve({
            id,
            companyId: "company-1",
            name: "Archived User Assistant",
            role: "general",
            status: "active",
            pauseReason: null,
          });
        }
        return Promise.resolve(null);
      }),
      create: vi.fn(() => Promise.resolve({ id: "unused-agent", companyId: "company-1" })),
      resume: vi.fn(() => Promise.resolve(undefined)),
      pause: vi.fn(() => Promise.resolve(undefined)),
      terminate: vi.fn(() => Promise.resolve(undefined)),
    };

    await syncEmployeeMembershipState(
      db as never,
      access as never,
      agents as never,
      "company-1",
      "membership-2",
      "board-user-1",
    );

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ availabilityStatus: "suspended" }),
    );
    expect(agents.terminate).toHaveBeenCalledWith("assistant-agent-2");
    expect(agents.pause).not.toHaveBeenCalled();
    expect(agents.resume).not.toHaveBeenCalled();
  });
});