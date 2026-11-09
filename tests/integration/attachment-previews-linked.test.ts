import { expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { qualifyId } from "@canopy/domain/computers";
import { ATTACHMENT_PREVIEW_BYTES } from "@canopy/domain/attachment-preview";
import { configComputer, pairConfig } from "./support/config-sync.ts";
import { eventually, failure } from "./support/gateway.ts";

test.skipIf(!dockerAvailable)(
  "bounded attachment previews and full downloads read from their home",
  async () => {
    const a = await configComputer("Preview A");
    const b = await configComputer("Preview B");

    try {
      await pairConfig(a, b);
      expect(await eventually(async () => a.links.reachable().includes(b.node), Boolean, 15_000)).toBe(true);
      const data = new TextEncoder().encode("linked log entry\n".repeat(10_000));
      const file = (await b.gateway.api.uploadAttachment({ name: "remote.log", data })).attachment!;
      const attachmentId = qualifyId(file.id, b.node);
      const preview = await a.gateway.api.getAttachment({ attachmentId, preview: true });
      expect(preview.data).toEqual(data.subarray(0, ATTACHMENT_PREVIEW_BYTES));
      expect(preview.truncated).toBe(true);
      expect(preview.attachment?.id).toBe(attachmentId);
      expect((await a.gateway.api.getAttachment({ attachmentId })).data).toEqual(data);
      expect(await failure(a.gateway.api.getAttachment({ attachmentId: file.id, preview: true }))).toContain(
        "not found",
      );
    } finally {
      await b.close();
      await a.close();
    }
  },
  60_000,
);
