import { afterEach, expect, test } from "bun:test";
import { slackAdapter } from "../../apps/gateway/src/messengers/slack.ts";

const credentials = { appToken: "xapp-fixture", botToken: "xoxb-fixture" };
const servers: ReturnType<typeof Bun.serve>[] = [];

/** Slack Web API plus its upload host on one local origin. */
function slack(options: { missingScope?: boolean } = {}) {
  const calls: { method: string; fields: URLSearchParams; bytes?: number }[] = [];

  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request): Promise<Response> => {
      const path = new URL(request.url).pathname;

      if (path.startsWith("/upload/")) {
        calls.push({
          method: "upload",
          fields: new URLSearchParams(),
          bytes: (await request.arrayBuffer()).byteLength,
        });

        return new Response("OK");
      }

      const method = path.slice("/api/".length);
      const fields = new URLSearchParams(await request.text());
      calls.push({ method, fields });

      if (method === "files.getUploadURLExternal")
        return options.missingScope
          ? Response.json({ ok: false, error: "missing_scope" })
          : Response.json({
              ok: true,
              file_id: `F${calls.length}`,
              upload_url: `http://127.0.0.1:${server.port}/upload/${calls.length}`,
            });

      if (method === "files.completeUploadExternal") return Response.json({ ok: true, files: [] });

      return Response.json({ ok: true, ts: "10.000001", channel: fields.get("channel") });
    },
  });

  servers.push(server);

  return { calls, transport: { apiBaseUrl: `http://127.0.0.1:${server.port}/api/` } };
}

const message = {
  id: "0190e000-0000-7000-8000-000000000001",
  accountId: "account",
  channelId: "CGENERAL",
  threadId: "100.1",
  text: "Here is the report.",
  files: [{ name: "report.pdf", mimeType: "application/pdf", data: new Uint8Array(1024) }],
};

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

test("files are uploaded before anything is visible, then shared in the reply thread after the text", async () => {
  const f = slack();

  expect(await slackAdapter.send(credentials, message, AbortSignal.timeout(2000), f.transport)).toEqual({
    channelId: "CGENERAL",
    messageId: "10.000001",
  });
  expect(f.calls.map((call) => call.method)).toEqual([
    "files.getUploadURLExternal",
    "upload",
    "chat.postMessage",
    "files.completeUploadExternal",
  ]);
  expect(Object.fromEntries(f.calls[0]!.fields)).toEqual({ filename: "report.pdf", length: "1024" });
  expect(f.calls[1]!.bytes).toBe(1024);
  expect(Object.fromEntries(f.calls[3]!.fields)).toEqual({
    files: JSON.stringify([{ id: "F1", title: "report.pdf" }]),
    channel_id: "CGENERAL",
    thread_ts: "100.1",
  });
});

test("an app without files:write refuses the whole reply before posting its text", async () => {
  const f = slack({ missingScope: true });

  const refused = await slackAdapter.send(credentials, message, AbortSignal.timeout(2000), f.transport).then(
    () => undefined,
    (error: Error) => error,
  );

  // Refused before any visible write, so the owner is told the reply was not sent.
  expect(refused).toMatchObject({ kind: "configuration", code: "missing_scope" });
  expect(f.calls.map((call) => call.method)).toEqual(["files.getUploadURLExternal"]);
});
