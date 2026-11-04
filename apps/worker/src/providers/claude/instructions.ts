import { join } from "node:path";
import { readEnvironmentBlock } from "@canopy/domain/agent-environment";
import { readInstructionFile } from "../../agent-environment/files.ts";

/** User settings stay disabled. Only the isolated home's managed instructions enter the platform prompt. */
export function managedClaudeInstructions(home: string): string {
  try {
    return readEnvironmentBlock(readInstructionFile(join(home, "CLAUDE.md")).text ?? "")?.content ?? "";
  } catch {
    return "";
  }
}
