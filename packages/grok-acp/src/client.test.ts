import { expect, test } from "bun:test";
import { GrokClient, type PromptEvent } from "./index.ts";
const args = [import.meta.dir + "/fixtures/agent.ts"];
const collect = async (events: AsyncIterable<PromptEvent>) => { const result: PromptEvent[] = []; for await (const event of events) result.push(event); return result; };

test("NDJSON framing, Unicode, consecutive turns, persisted session and process disposal", async () => {
  const client = new GrokClient({ executable: process.execPath, args });
  const pid = client.pid!;
  try {
    expect((await client.initialize()).agentInfo?.name).toBe("fake-żółć");
    const session = await client.newSession(import.meta.dir);
    for (let i = 0; i < 2; i++) expect(await collect(client.prompt(session.sessionId, [{ type: "text", text: "hello" }]))).toEqual([
      { type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Zażółć" } } }, { type: "complete", stopReason: "end_turn" },
    ]);
    expect((await client.loadSession(session.sessionId, import.meta.dir)).sessionId).toBe(session.sessionId);
  } finally { await client.dispose(); }
  expect(() => process.kill(pid, 0)).toThrow();
});
test("bidirectional permissions complete the blocked prompt", async () => {
  const client = new GrokClient({ executable: process.execPath, args, callbacks: { requestPermission: async (request) => ({ outcome: { outcome: "selected", optionId: request.options.find((o) => o.kind === "reject_once")!.optionId } }) } });
  try {
    await client.initialize();
    const events = await collect(client.prompt("fake-session", [{ type: "text", text: "permission" }]));
    expect(events[0]).toMatchObject({ type: "update", update: { content: { text: "no" } } });
  } finally { await client.dispose(); }
});
test("cancel resolves a running turn and leaves the session usable", async () => {
  const client = new GrokClient({ executable: process.execPath, args });
  try {
    await client.initialize();
    const stream = client.prompt("fake-session", [{ type: "text", text: "hang" }]);
    const pending = stream.next();
    await client.cancel("fake-session");
    expect((await pending).value).toEqual({ type: "complete", stopReason: "cancelled" });
    await stream.next();
    expect((await collect(client.prompt("fake-session", [{ type: "text", text: "hello" }]))).at(-1)).toMatchObject({ stopReason: "end_turn" });
  } finally { await client.dispose(); }
});
test("crashes reject pending prompts; stderr is redacted", async () => {
  const client = new GrokClient({ executable: process.execPath, args, secrets: ["sensitive-test-token"] });
  try {
    await client.initialize();
    await expect(collect(client.prompt("fake-session", [{ type: "text", text: "crash" }]))).rejects.toThrow();
    expect(client.stderr).not.toContain("sensitive-test-token");
  } finally { await client.dispose(); }
});
test("timeout terminates a stuck process and rejects every outstanding request", async () => {
  const client = new GrokClient({ executable: process.execPath, args, promptTimeoutMs: 30 });
  try {
    await client.initialize();
    await expect(collect(client.prompt("fake-session", [{ type: "text", text: "hang" }]))).rejects.toThrow("timed out");
  } finally { await client.dispose(); }
});
