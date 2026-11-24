import agentMemory from "./0193_agent_memory.sql" with { type: "text" };
import threadMemoryAudience from "./0194_thread_memory_audience.sql" with { type: "text" };
import memoryNoteCreation from "./0196_memory_note_creation.sql" with { type: "text" };
import memoryReflection from "./0198_memory_reflection.sql" with { type: "text" };
import memoryReflectionHourly from "./0209_memory_reflection_hourly.sql" with { type: "text" };
import { sqlFile } from "./run.ts";

export const memoryMigrations = {
  "0193_agent_memory": sqlFile(agentMemory),
  "0194_thread_memory_audience": sqlFile(threadMemoryAudience),
  "0196_memory_note_creation": sqlFile(memoryNoteCreation),
  "0198_memory_reflection": sqlFile(memoryReflection),
  "0209_memory_reflection_hourly": sqlFile(memoryReflectionHourly),
};
