import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { z } from "zod";
import { AgentToolOutputSchema, type AgentToolOutput, type RunAgentTool } from "@canopy/contracts";
import { runProcess } from "@canopy/process-governor";
import { installEnv } from "../cli-tools/installer.ts";
import { agentToolSpec } from "./specs.ts";
import { agentToolOperationArgs } from "./argv.ts";
import { toolArgv, toolEnvironment, type ToolEnv } from "./paths.ts";
import { serializeAgentTool } from "./queue.ts";
import { readAgentToolScreenshot } from "./screenshot.ts";
import { agentToolOutputText, MAX_AGENT_TOOL_TEXT_BYTES } from "./text.ts";

const OPERATION_TIMEOUT = 60_000;
const failureEnvelope = z.object({ success: z.literal(false) }).or(z.object({ ok: z.literal(false) }));

function failedEnvelope(stdout: string): boolean {
  try {
    return failureEnvelope.safeParse(JSON.parse(stdout)).success;
  } catch {
    return false;
  }
}

export function runAgentToolOperation(
  command: RunAgentTool,
  executable: string,
  env: ToolEnv = process.env,
): Promise<AgentToolOutput> {
  // Validate before queuing or starting a process, including flags hidden in target/value.
  agentToolOperationArgs(command, "screenshot.png");

  return serializeAgentTool("operations", () => execute(command, executable, env), 2_500);
}

async function execute(command: RunAgentTool, executable: string, sourceEnv: ToolEnv): Promise<AgentToolOutput> {
  const spec = agentToolSpec(command.tool);
  const workDir = mkdtempSync(join(tmpdir(), "canopy-agent-tool-"));
  const screenshotPath = join(workDir, "screenshot.png");
  const { secrets } = installEnv(sourceEnv);
  const env = toolEnvironment(sourceEnv);

  try {
    const args = agentToolOperationArgs(command, screenshotPath);

    const input = {
      argv: toolArgv(executable, args, env),
      cwd: workDir,
      env,
      timeoutMs: OPERATION_TIMEOUT,
      maxBytes: MAX_AGENT_TOOL_TEXT_BYTES * 2,
    };

    // Stateful operations must never be coalesced by processKey: two identical clicks mean two clicks.
    const result = await runProcess(input, { kind: "utility", maxQueueMs: 2_500 });
    const output = agentToolOutputText(result.stdout, result.stderr, secrets);

    if (result.code !== 0 || failedEnvelope(result.stdout))
      throw new Error(output.text || `${spec.label} exited with code ${result.code}`);

    return create(AgentToolOutputSchema, {
      operation: command.operation,
      text: output.text,
      truncated: output.truncated,
      ...(command.operation === "screenshot" && {
        mimeType: "image/png",
        data: await readAgentToolScreenshot(screenshotPath),
      }),
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
