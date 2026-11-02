/**
 * Live, through the whole stack: attachments. A screenshot (a PNG with a number drawn in it) and a text file go with
 * a message to a Codex and a Claude thread; the worker fetches them into its attachments directory, the model gets
 * the platform note with their paths, looks at the image (view_image, or the harness's own image read) and reads the
 * file, and the transcript item of that look has a preview the owner can read.
 * Opt-in: OA_LIVE=1 with the CLIProxyAPI env (docs/codex-adapter.md#testy-na-żywo).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionMode, Provider } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { GatewayStore } from "@open-agents/gateway/store";
import { journalHello, openGatewayLink } from "@open-agents/worker/gateway-link";
import { Journal } from "@open-agents/worker/journal";
import { serveLink, WorkerHost } from "@open-agents/worker/runtime";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import sharp from "sharp";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { useLiveProxy } from "./support/live.ts";

const LIVE = process.env["OA_LIVE"] === "1";
const proxyUrl = process.env["OA_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["OA_LIVE_CLIPROXYAPI_KEY"];

const CASES = [
  { name: "Codex", provider: Provider.CODEX, model: process.env["OA_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol" },
  { name: "Claude", provider: Provider.CLAUDE, model: process.env["OA_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5" },
] as const;

/** A "screenshot": a dialog with the number 4721 in large type. */
async function screenshot(): Promise<Uint8Array> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">
    <rect width="1600" height="900" fill="#f4f4f5"/><rect x="300" y="200" width="1000" height="500" rx="24" fill="#ffffff" stroke="#3b82f6" stroke-width="8"/>
    <text x="800" y="380" font-family="sans-serif" font-size="64" text-anchor="middle" fill="#111">Order confirmed</text>
    <text x="800" y="560" font-family="sans-serif" font-size="160" font-weight="bold" text-anchor="middle" fill="#dc2626">4721</text></svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
}

describe.skipIf(!LIVE || !proxyUrl || !proxyKey || !dockerAvailable)("attachments with a real worker (live)", () => {
  let gw: TestGateway;
  let workerId = "";
  let workspaceId = "";
  let projectId = "";
  let dataDir = "";
  let stop = async () => {};
  const dirs: string[] = [];
  const query = <A extends object>(text: string, ...params: unknown[]) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<A>(text, params as never[]);
      }),
    );

  beforeAll(async () => {
    gw = await startTestGateway();
    const repo = mkdtempSync(join(tmpdir(), "oa-live-att-repo-"));
    const data = mkdtempSync(join(tmpdir(), "oa-live-att-worker-"));
    dataDir = join(data, "data");
    dirs.push(repo, data);
    const added = await gw.runtime.runPromise(GatewayStore.use((s) => s.addWorker({ name: "live", ownerUserId: gw.userId })));
    workerId = added.workerId;
    await useLiveProxy(gw, workerId, { url: proxyUrl!, key: proxyKey!, allowedRoots: [repo] });
    const runtime = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));
    const host = new WorkerHost({ runtime, dataDir, clientVersion: "live" });
    const link = await openGatewayLink({
      baseUrl: gw.grpcUrl,
      credential: added.credential,
      hello: { workerId, attachmentsRoot: host.attachmentsRoot, host: { os: process.platform }, ...(await runtime.runPromise(journalHello())) },
    });
    const serving = serveLink(link, host, runtime);
    stop = async () => {
      link.close();
      await serving;
      await host.close();
      await runtime.dispose();
    };
    projectId = (await gw.api.createProject({ name: "Live attachments" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId, rootPath: repo, label: "live" })).workspace!.id;
  }, 120_000);

  afterAll(async () => {
    await stop();
    await gw?.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  for (const c of CASES) {
    test(`${c.name}: a screenshot and a text file reach the agent, which looks at them; the transcript shows the image`, async () => {
      await eventually(() => gw.api.listModels({ workerId }), (r) => (r.workers[0]?.profiles.length ?? 0) >= 2, 90_000);
      const shot = (await gw.api.uploadAttachment({ name: "Screenshot 2026-11-02.png", data: await screenshot() })).attachment!;
      const notes = (await gw.api.uploadAttachment({ name: "notes.txt", data: new TextEncoder().encode("The codeword is PELICAN.\n") })).attachment!;
      const thread = (
        await gw.api.createThread({
          projectId,
          workspaceId,
          title: `${c.name} attachments`,
          provider: c.provider,
          providerProfileId: "cliproxyapi",
          model: c.model,
          permissionMode: PermissionMode.READ_ONLY,
          initialMessage:
            "What is in these attachments? Look at the image and read the text file. Reply with one line: 'NUMBER: <the big number in the image>; CODEWORD: <the codeword in the file>'.",
          initialAttachmentIds: [shot.id, notes.id],
        })
      ).thread!;

      const answer = await eventually(
        () => query<{ text: string }>(
          "SELECT content->'agentMessage'->>'text' AS text FROM thread_items WHERE thread_id = $1::uuid AND type = 'agent_message' ORDER BY first_seq",
          thread.id,
        ),
        (rows) => rows.some((r) => /NUMBER:\s*4721/.test(r.text ?? "") && /PELICAN/.test(r.text ?? "")),
        300_000,
      );
      console.info(`${c.name} answered: ${answer.map((r) => r.text).join(" | ")}`);
      expect(answer.some((r) => /NUMBER:\s*4721/.test(r.text) && /PELICAN/.test(r.text))).toBe(true);

      // The files are where the note said, in the worker's data directory (outside the repository).
      expect(existsSync(join(dataDir, "attachments", thread.id, shot.id, "Screenshot 2026-11-02.png"))).toBe(true);
      expect(existsSync(join(dataDir, "attachments", thread.id, notes.id, "notes.txt"))).toBe(true);

      // How the agent looked at the image, and the preview of what it saw.
      const items = await query<{ type: string; content: { image?: { source?: string; path?: string; blob?: { sha256: string } }; toolCall?: { name?: string; images?: { sha256: string }[] } } }>(
        "SELECT type, content FROM thread_items WHERE thread_id = $1::uuid AND type IN ('image', 'tool_call') ORDER BY first_seq",
        thread.id,
      );
      const looks = items.flatMap((i) => {
        const sha = i.content.image?.blob?.sha256 ?? i.content.toolCall?.images?.[0]?.sha256;
        return sha ? [{ how: i.content.image ? `image:${i.content.image.source}` : `tool:${i.content.toolCall?.name}`, sha }] : [];
      });
      console.info(`${c.name} looked at the image with: ${looks.map((l) => l.how).join(", ") || "nothing with a preview"}; items: ${items.map((i) => i.content.image ? `image:${i.content.image.source}` : `tool:${i.content.toolCall?.name}`).join(", ")}`);
      expect(looks.length).toBeGreaterThan(0);
      const preview = await gw.api.getThreadBlob({ threadId: thread.id, sha256: looks[0]!.sha });
      const meta = await sharp(preview.data).metadata();
      expect(meta.width).toBeGreaterThan(100);
    }, 600_000);
  }
});
