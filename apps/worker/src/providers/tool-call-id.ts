import { createHash } from "node:crypto";

/**
 * Platform id of a provider tool call (agent_bus_calls.id). Deterministic, so a call re-sent after a
 * reconnect, or re-asked by the provider after a worker restart, maps to the same stored call.
 * A UUID (version 8, name-based) from the platform thread id and the provider's call id.
 */
export function toolCallId(threadId: string, providerCallId: string): string {
  const bytes = createHash("sha256").update(`${threadId}\u0000${providerCallId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
