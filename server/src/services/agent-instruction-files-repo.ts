import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentInstructionFiles } from "@paperclipai/db";

type InstructionFileRow = typeof agentInstructionFiles.$inferSelect;

export type AgentInstructionFileRecord = {
  id: string;
  agentId: string;
  filePath: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
};

function toRecord(row: InstructionFileRow): AgentInstructionFileRecord {
  return {
    id: row.id,
    agentId: row.agentId,
    filePath: row.filePath,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function instructionFilesRepo(db: Db) {
  return {
    findByAgent: async (agentId: string): Promise<AgentInstructionFileRecord[]> => {
      const rows = await db
        .select()
        .from(agentInstructionFiles)
        .where(eq(agentInstructionFiles.agentId, agentId))
        .orderBy(agentInstructionFiles.filePath);
      return rows.map(toRecord);
    },

    findOne: async (agentId: string, filePath: string): Promise<AgentInstructionFileRecord | null> => {
      const [row] = await db
        .select()
        .from(agentInstructionFiles)
        .where(
          and(
            eq(agentInstructionFiles.agentId, agentId),
            eq(agentInstructionFiles.filePath, filePath),
          ),
        );
      return row ? toRecord(row) : null;
    },

    upsert: async (agentId: string, filePath: string, content: string): Promise<AgentInstructionFileRecord> => {
      const now = new Date();
      const [row] = await db
        .insert(agentInstructionFiles)
        .values({ agentId, filePath, content, updatedAt: now })
        .onConflictDoUpdate({
          target: [agentInstructionFiles.agentId, agentInstructionFiles.filePath],
          set: { content, updatedAt: now },
        })
        .returning();
      return toRecord(row);
    },

    deleteOne: async (agentId: string, filePath: string): Promise<void> => {
      await db
        .delete(agentInstructionFiles)
        .where(
          and(
            eq(agentInstructionFiles.agentId, agentId),
            eq(agentInstructionFiles.filePath, filePath),
          ),
        );
    },

    deleteAllForAgent: async (agentId: string): Promise<void> => {
      await db
        .delete(agentInstructionFiles)
        .where(eq(agentInstructionFiles.agentId, agentId));
    },

    countByAgent: async (agentId: string): Promise<number> => {
      const [result] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(agentInstructionFiles)
        .where(eq(agentInstructionFiles.agentId, agentId));
      return Number(result.count);
    },

    filePathsByAgent: async (agentId: string): Promise<string[]> => {
      const rows = await db
        .select({ filePath: agentInstructionFiles.filePath })
        .from(agentInstructionFiles)
        .where(eq(agentInstructionFiles.agentId, agentId))
        .orderBy(agentInstructionFiles.filePath);
      return rows.map((r) => r.filePath);
    },
  };
}
