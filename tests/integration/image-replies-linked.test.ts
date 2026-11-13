import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { isMessage } from "@bufbuild/protobuf";
import { ExportThreadImageSchema, Provider, type AgentToolResult } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { qualifyId, splitId } from "@canopy/domain/computers";
import { THREAD_IMAGE_REPLIES_CAPABILITY } from "@canopy/domain/release/protocol";
import { GatewayStore } from "@canopy/gateway/store";
import { attachmentResponse } from "../../apps/web/src/lib/server/attachment-response.ts";
import { configComputer, pairConfig } from "./support/config-sync.ts";
import { eventually, failure, watchUntil } from "./support/gateway.ts";

test.skipIf(!dockerAvailable)(
  "published image manifests and attachment reads survive a linked home restart",
  async () => {
    const home = await configComputer("Image home");
    const viewer = await configComputer("Image viewer");
    home.links.options.heartbeatMs = 1500;
    viewer.links.options.heartbeatMs = 1500;

    const png = Uint8Array.fromBase64(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    );

    try {
      await pairConfig(home, viewer);
      home.gateway.worker.link.close();

      const worker = await home.gateway.connect(home.gateway.workerId, home.gateway.workerCredential, undefined, {
        hello: { capabilities: [THREAD_IMAGE_REPLIES_CAPABILITY] },
      });

      worker.holdTurns = true;
      worker.handlers.set("exportThreadImage", (value, reply) => {
        if (!isMessage(value, ExportThreadImageSchema)) return reply(false);
        reply(true, {
          threadImageExport: {
            name: "screen.png",
            sizeBytes: BigInt(png.length),
            sha256: createHash("sha256").update(png).digest("hex"),
            data:
              value.operation === "read"
                ? png.slice(Number(value.offset), Number(value.offset) + 256 * 1024)
                : new Uint8Array(),
          },
        });
      });
      const projectId = (await home.gateway.api.createProject({ name: "Published images" })).project!.id;

      const workspaceId = (
        await home.gateway.api.createWorkspace({ projectId, workerId: home.gateway.workerId, rootPath: "/repo/images" })
      ).workspace!.id;

      const thread = (
        await home.gateway.api.createThread({
          projectId,
          workspaceId,
          provider: Provider.CODEX,
          title: "Image publication",
        })
      ).thread!;

      await eventually(
        () => home.gateway.api.getThread({ threadId: thread.id }),
        (r) => r.thread?.status === "idle",
      );

      const turn = (
        await home.gateway.api.sendMessage({
          threadId: thread.id,
          text: "Show the screenshot",
          clientRequestId: crypto.randomUUID(),
        })
      ).turn!;

      await eventually(
        () => home.gateway.runtime.runPromise(GatewayStore.use((s) => s.turnsOf(thread.id))),
        (rows) => rows.some((row) => row.id === turn.id && row.status === "running"),
      );

      const result: AgentToolResult = await worker.callTool({
        threadId: thread.id,
        turnId: turn.id,
        tool: "show_images",
        args: { images: [{ path: "screen.png", alt: "Linked screenshot", caption: "Saved at its home" }] },
      });

      expect(result.isError).toBe(false);
      worker.finish(thread.id, turn.id);
      const qualified = qualifyId(thread.id, home.node);

      const updates = await watchUntil(viewer.gateway.api, qualified, (rows) =>
        rows.some(
          (row) =>
            row.change.case === "snapshot" &&
            row.change.value.items.some((entry) => entry.item?.content.case === "imageGallery"),
        ),
      );

      const manifest = updates
        .flatMap((row) => (row.change.case === "snapshot" ? row.change.value.items : []))
        .find((entry) => entry.item?.content.case === "imageGallery")?.item;

      expect(manifest?.content.case).toBe("imageGallery");
      const image = manifest?.content.case === "imageGallery" ? manifest.content.value.images[0] : undefined;
      expect(image?.attachmentId).toBe(qualifyId(splitId(image!.attachmentId).id, home.node));
      const attachmentId = image!.attachmentId;
      const first = await viewer.gateway.api.getAttachment({ attachmentId });
      expect(first.mimeType).toBe("image/png");
      expect((await viewer.gateway.api.getAttachment({ attachmentId, thumbnail: true })).mimeType).toBe("image/webp");

      const response = await attachmentResponse(
        viewer.gateway.api,
        attachmentId,
        new URL(`http://localhost/api/attachments/${encodeURIComponent(attachmentId)}?thumbnail`),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      await home.restart();
      expect(await eventually(async () => viewer.links.reachable().includes(home.node), Boolean, 15_000)).toBe(true);
      expect((await viewer.gateway.api.getAttachment({ attachmentId })).data).toEqual(first.data);

      const stranger = await home.gateway.runtime.runPromise(
        GatewayStore.use((s) => s.ensureUser("image-stranger@test", "Other")),
      );

      await home.store.query("UPDATE attachments SET owner_user_id=$1::uuid WHERE id=$2::uuid", [
        stranger,
        splitId(attachmentId).id,
      ]);
      expect(await failure(viewer.gateway.api.getAttachment({ attachmentId }))).toContain("not found");
    } finally {
      await viewer.close();
      await home.close();
    }
  },
  60_000,
);
