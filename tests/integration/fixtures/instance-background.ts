import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "@canopy/domain";
import { releaseProbe } from "./instance-probe.ts";

/** A background app server ends after the test releases it, then Claude attempts its native wake-up. */
export async function archivedBackground(session: string, send: (message: JsonObject) => void) {
  const message = (fields: JsonObject) => send({ session_id: session, uuid: crypto.randomUUID(), ...fields });

  const result = () =>
    message({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result: "Background work finished",
      total_cost_usd: 0,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      stop_reason: "end_turn",
    });

  message({
    type: "system",
    subtype: "task_started",
    task_id: "app-server",
    tool_use_id: "app-server-tool",
    description: "Local app server",
    is_backgrounded: true,
    task_type: "local_bash",
  });
  result();
  await releaseProbe("HOLD:background-archive");
  const output = join(process.cwd(), "background-output.txt");
  writeFileSync(output, "Server stopped after the background task limit\n");
  message({
    type: "system",
    subtype: "task_notification",
    task_id: "app-server",
    tool_use_id: "app-server-tool",
    status: "completed",
    output_file: output,
    summary: "Local app server stopped after the background task limit",
  });
  message({ type: "system", subtype: "init", tools: [], model: "fixture-model", cwd: process.cwd() });
  message({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id: crypto.randomUUID(),
      type: "message",
      role: "assistant",
      model: "fixture-model",
      content: [{ type: "text", text: "The app server stopped. Background work finished." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  result();
}
