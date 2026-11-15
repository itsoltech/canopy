export const MAX_AGENT_TOOL_TEXT_BYTES = 512 * 1024;
const MARKER = "\n[output truncated]";

/** The wire limit includes the marker and counts UTF-8 bytes, without splitting a code point. */
export function agentToolOutputText(stdout: string, stderr: string, secrets: readonly string[]) {
  let text = (stdout || stderr).trim();

  for (const secret of secrets) text = text.replaceAll(secret, "***");
  const bytes = Buffer.from(text);

  if (bytes.length <= MAX_AGENT_TOOL_TEXT_BYTES) return { text, truncated: false };
  let end = MAX_AGENT_TOOL_TEXT_BYTES - Buffer.byteLength(MARKER);

  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;

  return { text: `${bytes.subarray(0, end).toString("utf8")}${MARKER}`, truncated: true };
}
