import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { isMessage } from "@bufbuild/protobuf";
import { ExportThreadImageSchema, ItemStatus, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { THREAD_IMAGE_REPLIES_CAPABILITY } from "@canopy/domain/release/protocol";
import { eventually, startTestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("local Temp permission over WorkerLink", () => {
  test.each([
    { role: "desktop", os: "win32", bundled: true, allowed: true },
    { role: "desktop", os: "win32", bundled: false, allowed: false },
    { role: "desktop", os: "linux", bundled: true, allowed: false },
    { role: "server", os: "win32", bundled: true, allowed: false },
  ] as const)(
    "show_images with $role gateway and $os worker (bundled: $bundled)",
    async ({ role, os, bundled, allowed }) => {
      const capabilities = [THREAD_IMAGE_REPLIES_CAPABILITY, ...(bundled ? ["desktop_bundled"] : [])];

      const gw = await startTestGateway({
        role,
        worker: { hello: { host: { os }, capabilities, attachmentsRoot: "" } },
      });

      const cwd = os === "win32" ? "C:\\repo\\screens" : "/repo/screens";
      const path = "C:/Users/Example/AppData/Local/Temp/capture.png";

      const bytes = Uint8Array.fromBase64(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      );

      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const probes: { path: string; allowLocalTemp: boolean; roots: string[] }[] = [];

      try {
        gw.worker.handlers.set("exportThreadImage", (value, reply) => {
          if (!isMessage(value, ExportThreadImageSchema)) return reply(false);

          if (value.operation === "release") return reply(true, { threadImageExport: {} });

          if (value.operation === "probe") probes.push(value);

          if (!value.allowLocalTemp) return reply(false, { errorMessage: "Temp export refused." });

          return reply(true, {
            threadImageExport: {
              name: "capture.png",
              sizeBytes: BigInt(bytes.length),
              ...(value.operation === "read" && { data: bytes, sha256 }),
            },
          });
        });
        const projectId = (await gw.api.createProject({ name: "Screenshot publication" })).project!.id;

        const workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: cwd }))
          .workspace!.id;

        const threadId = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX })).thread!.id;
        await eventually(
          () => gw.api.getThread({ threadId }),
          (r) => r.thread?.status === "idle",
        );
        gw.worker.holdTurns = true;

        const sent = await gw.api.sendMessage({
          threadId,
          text: "Show the screenshot",
          clientRequestId: crypto.randomUUID(),
        });

        const turnId = sent.turn!.id;
        await eventually(
          () => gw.api.getThread({ threadId }),
          (r) => r.thread?.status === "running",
        );

        const shown = await gw.worker.callTool({
          threadId,
          turnId,
          tool: "show_images",
          args: { images: [{ path, alt: "External screenshot" }] },
        });

        expect(shown.isError).toBe(!allowed);
        expect(probes).toHaveLength(1);
        expect(probes[0]).toMatchObject({ path, allowLocalTemp: allowed, roots: [cwd] });

        if (allowed) {
          const itemId = "markdown-capture";
          gw.worker.emit(threadId, turnId, {
            case: "itemCompleted",
            value: {
              item: {
                itemId,
                status: ItemStatus.COMPLETED,
                content: { case: "agentMessage", value: { text: `![External screenshot](${path})` } },
              },
            },
          });

          const imported = await gw.worker.callTool({
            threadId,
            turnId,
            tool: "import_image_reply",
            args: { item_id: itemId },
          });

          expect(imported.isError).toBe(true);
          expect(probes).toHaveLength(2);
          expect(probes[1]).toMatchObject({ path, allowLocalTemp: false, roots: [cwd] });
        }
      } finally {
        await gw.close();
      }
    },
    30_000,
  );
});
