import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { AgentToolCallSchema, type AgentToolCall, type AgentToolResult } from "@canopy/contracts";
import { z } from "zod";
import type { LoginLease } from "../agent-tools-mcp/session-policy.ts";

/** Worker-internal gateway call; harness catalogs never list it. */
export const LEASE_PROJECT_LOGIN = "lease_project_login";

const Result = z.object({
  request_id: z.string(),
  status: z.string(),
  approval: z.string().optional(),
});

function message(name: string, status: string, approval?: string): string {
  if (status === "pending" && approval)
    return `Waiting for the owner to allow login ${name} in Canopy. Call this tool again to continue once they answer.`;

  if (status === "pending") return `Login ${name} is still reaching this computer. Call this tool again.`;

  if (status === "declined") return `The owner declined login ${name} for this turn. Ask them before trying again.`;

  if (status === "revoked") return `The owner revoked login ${name} for this turn. Ask them before trying again.`;

  return `Login ${name} is no longer available in this turn. Call this tool again to request it.`;
}

/** Asks the gateway for a browser lease of a project login in the current turn. */
export function loginLeaser(
  callTool: (call: AgentToolCall, signal?: AbortSignal) => Promise<AgentToolResult>,
  threadId: string,
  turnId: () => string,
  authorization: string,
) {
  return async (name: string, origin: string, signal: AbortSignal): Promise<LoginLease> => {
    const turn = turnId();

    if (!turn) return { ok: false, message: "Enter logins during an active turn." };
    const callId = Bun.randomUUIDv7();

    const result = await callTool(
      create(AgentToolCallSchema, {
        callId,
        threadId,
        turnId: turn,
        itemId: callId,
        toolName: LEASE_PROJECT_LOGIN,
        argumentsJson: JSON.stringify({ name, origin, authorization }),
        expiresAt: timestampFromDate(new Date(Date.now() + 130_000)),
      }),
      signal,
    );

    if (result.isError) return { ok: false, message: result.content || `Login ${name} is unavailable.` };

    try {
      const parsed = Result.parse(JSON.parse(result.resultJson || result.content));

      if (parsed.status === "saved" && turnId() === turn)
        return { ok: true, requestId: parsed.request_id, turnId: turn };

      return { ok: false, message: message(name, parsed.status, parsed.approval) };
    } catch {
      return { ok: false, message: `Login ${name} is unavailable.` };
    }
  };
}
