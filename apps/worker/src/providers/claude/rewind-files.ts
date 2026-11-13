import { query, type Query, type RewindFilesResult } from "@anthropic-ai/claude-agent-sdk";
import type { RewindThread } from "@canopy/contracts";

/** A resumed control query must finish loading its checkpoint history before a dry run or restore. */
export async function rewindClaudeFiles(
  request: RewindThread,
  options: Parameters<typeof query>[0]["options"],
): Promise<RewindFilesResult> {
  let control: Query | undefined;

  try {
    control = query({
      prompt: "",
      options: {
        ...options,
        resume: request.checkpointSessionId,
        enableFileCheckpointing: true,
        strictMcpConfig: true,
        mcpServers: {},
      },
    });
    await control[Symbol.asyncIterator]().next();

    return await control.rewindFiles(request.checkpointId, { dryRun: !request.restoreFiles });
  } finally {
    control?.close();
  }
}
