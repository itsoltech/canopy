import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { MentionKind, Provider, ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { dockerAvailable } from "@canopy/db/testing";
import { qualifyId, STEER_ATTACHMENTS, THREAD_WATCH_LIVENESS } from "@canopy/domain/computers";
import { ATTACHMENT_PREVIEW_BYTES } from "@canopy/domain/attachment-preview";
import { GatewayStore } from "@canopy/gateway/store";
import sharp from "sharp";
import { attachmentResponse } from "../../apps/web/src/lib/server/attachment-response.ts";
import { configComputer, pairConfig, type ConfigComputer } from "./support/config-sync.ts";
import { eventually, failure, watchUntil } from "./support/gateway.ts";

async function sentImage(home: ConfigComputer, viewer: ConfigComputer) {
  const png = new Uint8Array(
    await sharp({ create: { width: 1048, height: 354, channels: 3, background: "#3366cc" } })
      .png()
      .toBuffer(),
  );

  const image = (await home.gateway.api.uploadAttachment({ name: "image.png", data: png })).attachment!;
  const project = (await home.gateway.api.createProject({ name: "Attachments" })).project!;

  const workspace = (
    await home.gateway.api.createWorkspace({
      projectId: project.id,
      workerId: home.gateway.workerId,
      rootPath: "/repo/attachments",
    })
  ).workspace!;

  const thread = (
    await home.gateway.api.createThread({
      projectId: project.id,
      workspaceId: workspace.id,
      provider: Provider.CODEX,
      title: "Image",
      initialMessage: "[image.png]",
      initialAttachmentIds: [image.id],
      initialMentions: [{ kind: MentionKind.ATTACHMENT, name: image.id, label: image.name, start: 0, end: 11 }],
      clientRequestId: crypto.randomUUID(),
    })
  ).thread!;

  const updates = await watchUntil(viewer.gateway.api, qualifyId(thread.id, home.node), (updates) =>
    updates.some((u) => u.change.case === "snapshot" && u.change.value.turns.some((t) => t.attachments.length)),
  );

  const snapshot = updates.findLast((u) => u.change.case === "snapshot")!.change;

  if (snapshot.case !== "snapshot") throw new Error("Expected snapshot");
  const attached = snapshot.value.turns[0]!.attachments[0]!;
  expect(attached.id).toBe(qualifyId(image.id, home.node));
  expect(snapshot.value.turns[0]!.mentions[0]?.name).toBe(attached.id);

  return { attached, png, localId: image.id };
}

const bff = (viewer: ConfigComputer, id: string, query = "", ifNoneMatch?: string | null) =>
  attachmentResponse(
    viewer.gateway.api,
    id,
    new URL(`http://localhost/api/attachments/${encodeURIComponent(id)}${query}`),
    ifNoneMatch,
  );

async function imageReads(home: ConfigComputer, viewer: ConfigComputer) {
  const { attached, png, localId } = await sentImage(home, viewer);

  for (const query of ["?thumbnail", "?preview", "?image", ""]) {
    const thumbnail = query === "?thumbnail";

    const response = await viewer.gateway.api.getAttachment({
      attachmentId: attached.id,
      thumbnail,
      preview: query === "?preview",
    });

    expect(response.attachment?.id).toBe(attached.id);
    expect(response.data.length).toBeGreaterThan(0);
    expect(response.mimeType).toBe(thumbnail ? "image/webp" : "image/png");

    if (!thumbnail) expect(response.data).toEqual(png);
    const http = await bff(viewer, attached.id, query);
    expect(http.status).toBe(200);
    expect(new Uint8Array(await http.arrayBuffer())).toEqual(new Uint8Array(response.data));
    expect(http.headers.get("x-content-type-options")).toBe("nosniff");
    const etag = http.headers.get("etag");
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    const fresh = await bff(viewer, attached.id, query, etag);
    expect(fresh.status).toBe(304);
    expect(await fresh.text()).toBe("");
  }

  // Stale mirrored metadata can advertise a thumbnail that its home no longer has.
  await home.store.query("UPDATE attachments SET thumb_sha256=NULL WHERE id=$1::uuid", [localId]);
  expect((await viewer.gateway.api.getAttachment({ attachmentId: attached.id, thumbnail: true })).data).toEqual(png);
  expect((await bff(viewer, attached.id, "?thumbnail")).status).toBe(200);
  // A plain id is local, never guessed from metadata or searched across other owners/homes.
  expect((await bff(viewer, localId)).status).toBe(404);

  return attached;
}

test.skipIf(!dockerAvailable)(
  "linked attachment bytes, old homes, ownership and availability reach the BFF",
  async () => {
    const a = await configComputer("Preview A");
    const b = await configComputer("Preview B");

    // Image processing can block longer than the fixture's 450 ms heartbeat budget.
    // Availability below is driven by explicit listener shutdown, not heartbeat timing.
    a.links.options.heartbeatMs = 1500;
    b.links.options.heartbeatMs = 1500;

    try {
      // The older home predates the additive watch/steer capabilities as well as bounded previews.
      a.links.options.capabilities = a.links
        .hello()
        .capabilities.filter((capability) => ![STEER_ATTACHMENTS, THREAD_WATCH_LIVENESS].includes(capability));
      await pairConfig(a, b);
      expect(await eventually(async () => a.links.reachable().includes(b.node), Boolean, 15_000)).toBe(true);
      const image = await imageReads(a, b);
      await imageReads(b, a);

      // Before #398 the home ignored the additive preview field and returned the complete blob.
      const original = a.gateway.core.getAttachment.bind(a.gateway.core);
      a.gateway.core.getAttachment = (id, thumbnail) => original(id, thumbnail, false);
      const data = new TextEncoder().encode("linked log entry\n".repeat(10_000));
      const file = (await a.gateway.api.uploadAttachment({ name: "remote.log", data })).attachment!;
      const attachmentId = qualifyId(file.id, a.node);
      const preview = await b.gateway.api.getAttachment({ attachmentId, preview: true });
      expect(preview.data).toEqual(data.subarray(0, ATTACHMENT_PREVIEW_BYTES));
      expect(preview.truncated).toBe(true);
      expect(preview.attachment?.id).toBe(attachmentId);
      const http = await bff(b, attachmentId, "?preview");
      expect(http.headers.get("x-canopy-preview-truncated")).toBe("true");
      expect(new Uint8Array(await http.arrayBuffer())).toEqual(new Uint8Array(preview.data));
      expect((await b.gateway.api.getAttachment({ attachmentId })).data).toEqual(data);
      await imageReads(a, b);
      a.gateway.core.getAttachment = original;

      const stranger = await a.gateway.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("other@test", "Other")));
      await a.store.query("UPDATE attachments SET owner_user_id=$1::uuid WHERE id=$2::uuid", [stranger, file.id]);
      expect(await failure(b.gateway.api.getAttachment({ attachmentId, preview: true }))).toContain("not found");
      const denied = await bff(b, attachmentId, "?preview", http.headers.get("etag"));
      expect(denied.status).toBe(404);
      expect(denied.headers.get("cache-control")).toBe("no-store");
      expect(denied.headers.get("etag")).toBeNull();
      const available = await bff(b, image.id, "?thumbnail");

      await a.links.options.network.update(
        create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: false }),
      );
      await b.links.options.network.update(
        create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: false }),
      );
      expect(await eventually(async () => !b.links.reachable().length, Boolean)).toBe(true);
      const cause = await b.gateway.api.getAttachment({ attachmentId: image.id }).catch((cause: unknown) => cause);
      expect(cause).toBeInstanceOf(ConnectError);

      if (!(cause instanceof ConnectError)) throw new Error("Expected attachment failure");
      expect(cause.code).toBe(Code.Unavailable);
      expect(cause.rawMessage).toBe("Available when Preview A is connected.");
      const unavailable = await bff(b, image.id, "?thumbnail", available.headers.get("etag"));
      expect(unavailable.status).toBe(409);
      expect(await unavailable.json()).toMatchObject({ message: cause.rawMessage, scope: "computer" });
      expect(unavailable.headers.get("cache-control")).toBe("no-store");
      expect(unavailable.headers.get("etag")).toBeNull();

      await a.links.options.network.update(
        create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }),
      );
      await b.links.options.network.update(
        create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }),
      );
      expect(await eventually(async () => b.links.reachable().includes(a.node), Boolean, 15_000)).toBe(true);
      expect((await bff(b, image.id, "?thumbnail")).status).toBe(200);
    } finally {
      await b.close();
      await a.close();
    }
  },
  60_000,
);
