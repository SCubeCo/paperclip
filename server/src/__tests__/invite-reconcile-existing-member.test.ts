import { describe, expect, it, vi } from "vitest";
import { reconcileEmployeeInviteForExistingMember } from "../routes/access.js";

function createDbStub(selectResults: unknown[]) {
  const pendingSelects = [...selectResults];
  const updateSetMock = vi.fn();
  const insertValuesMock = vi.fn();

  const tx = {
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
        return {
          returning: vi.fn(() => Promise.resolve([{ id: "join-request-1" }])),
        };
      }),
    })),
  };

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(pendingSelects.shift() ?? [])),
      })),
    })),
    transaction: vi.fn(async (callback) => callback(tx as never)),
  };

  return { db, tx, updateSetMock, insertValuesMock };
}

describe("reconcileEmployeeInviteForExistingMember", () => {
  it("restores a removed account by reusing its archived membership", async () => {
    const { db, updateSetMock, insertValuesMock } = createDbStub([
      [
        {
          id: "membership-archived-1",
          companyId: "company-1",
          principalType: "user",
          principalId: "user-1",
          membershipRole: "member",
          status: "archived",
        },
      ],
      [],
      [],
    ]);

    const access = {
      setPrincipalGrants: vi.fn(() => Promise.resolve(undefined)),
      ensureMembership: vi.fn(() => Promise.resolve(undefined)),
    };
    const agents = {
      getById: vi.fn(() => Promise.resolve(null)),
      create: vi.fn(() => Promise.resolve(null)),
      resume: vi.fn(() => Promise.resolve(undefined)),
      pause: vi.fn(() => Promise.resolve(undefined)),
    };

    const result = await reconcileEmployeeInviteForExistingMember({
      db: db as never,
      access: access as never,
      agents: agents as never,
      req: {
        actor: { userId: "user-1" },
        header: vi.fn(() => null),
      } as never,
      invite: {
        id: "invite-1",
        companyId: "company-1",
        defaultsPayload: {
          human: {
            employeeMembershipId: "membership-placeholder-1",
            invitedEmail: "jane@example.com",
          },
        },
      } as never,
      companyId: "company-1",
      actorUserId: "user-1",
      actorEmail: "jane@example.com",
      employeeMembershipId: "membership-placeholder-1",
    });

    expect(result).toEqual({ id: "join-request-1" });
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active" }),
    );
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        inviteId: "invite-1",
        companyId: "company-1",
        requestType: "human",
        status: "approved",
        requestingUserId: "user-1",
      }),
    );
    expect(access.setPrincipalGrants).toHaveBeenCalledWith(
      "company-1",
      "user",
      "user-1",
      [{ permissionKey: "tasks:assign", scope: null }],
      "user-1",
    );
    expect(agents.getById).not.toHaveBeenCalled();
    expect(agents.create).not.toHaveBeenCalled();
  });
});
