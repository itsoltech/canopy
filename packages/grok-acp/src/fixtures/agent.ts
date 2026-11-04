import { createInterface } from "node:readline";

const send = (value: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
let promptId: number | undefined;
let ignoreCancel = false;

const updates = (sessionId: string, update: object) =>
  send({ method: "session/update", params: { sessionId, update } });

for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);

  if (m.method === "initialize") {
    // Deliberately fragment a UTF-8 frame across writes.
    const frame = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: m.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "fake-żółć", version: "1" },
          agentCapabilities: { loadSession: true },
        },
      }) + "\n",
    );

    process.stdout.write(frame.subarray(0, 99));
    process.stdout.write(frame.subarray(99));
  } else if (m.method === "session/new" || m.method === "session/load")
    send({ id: m.id, result: { sessionId: m.params.sessionId ?? "fake-session" } });
  else if (m.method === "session/prompt") {
    promptId = m.id;
    const text = m.params.prompt[0].text;

    if (text === "ignore-cancel") {
      ignoreCancel = true;
      continue;
    }

    if (text === "crash") {
      process.stderr.write("Bearer sensitive-test-token\n");
      process.exit(7);
    }

    if (text === "hang") continue;

    if (text === "permission") {
      send({
        id: "permission",
        method: "session/request_permission",
        params: {
          sessionId: "fake-session",
          toolCall: { toolCallId: "cmd", title: "pwd", kind: "execute" },
          options: [
            { optionId: "yes", kind: "allow_once", name: "Allow" },
            { optionId: "no", kind: "reject_once", name: "Deny" },
          ],
        },
      });
      continue;
    }

    updates("fake-session", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Zażółć" } });
    send({ id: m.id, result: { stopReason: "end_turn" } });
  } else if (m.id === "permission") {
    if (m.result.outcome.outcome === "cancelled") continue; // session/cancel, not a late callback, owns the prompt response
    updates("fake-session", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: m.result.outcome.optionId },
    });
    send({ id: promptId, result: { stopReason: "end_turn" } });
  } else if (m.method === "session/cancel" && !ignoreCancel)
    send({ id: promptId, result: { stopReason: "cancelled" } });
  else if (m.id) send({ id: m.id, result: {} });
}
