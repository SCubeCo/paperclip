import { pgTable, uniqueIndex, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

export const agentInstructionFiles = pgTable(
  "agent_instruction_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentFilePathIdx: uniqueIndex("agent_instruction_files_agent_file_path_idx").on(table.agentId, table.filePath),
  }),
);
