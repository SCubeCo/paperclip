import { describe, expect, it } from "vitest";
import { pickRequirementAnalysisLeadAgent } from "../routes/projects.js";

describe("pickRequirementAnalysisLeadAgent", () => {
  it("prefers CEO over non-CEO agents", () => {
    const selected = pickRequirementAnalysisLeadAgent([
      {
        id: "agent-b",
        role: "engineer",
        status: "active",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: "agent-a",
        role: "ceo",
        status: "active",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);

    expect(selected?.id).toBe("agent-a");
  });

  it("falls back to the oldest active agent when no CEO exists", () => {
    const selected = pickRequirementAnalysisLeadAgent([
      {
        id: "agent-b",
        role: "engineer",
        status: "active",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
      },
      {
        id: "agent-a",
        role: "qa",
        status: "active",
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
      },
    ]);

    expect(selected?.id).toBe("agent-a");
  });

  it("ignores terminated agents", () => {
    const selected = pickRequirementAnalysisLeadAgent([
      {
        id: "agent-a",
        role: "ceo",
        status: "terminated",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: "agent-b",
        role: "engineer",
        status: "active",
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
      },
    ]);

    expect(selected?.id).toBe("agent-b");
  });

  it("returns undefined when no active candidates exist", () => {
    const selected = pickRequirementAnalysisLeadAgent([
      {
        id: "agent-a",
        role: "ceo",
        status: "terminated",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    expect(selected).toBeUndefined();
  });
});
