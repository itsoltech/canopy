import { createHash } from "node:crypto";
import { create, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { commitThreadMedia, type ThreadMediaRequest } from "../store/image-gallery.ts";
import type { CallSource, ThreadRow } from "../store/index.ts";
import { coreState } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { transferThreadFiles } from "./thread-file-transfer.ts";

export function publishThreadMedia(
  core: GatewayCore,
  source: CallSource,
  caller: ThreadRow,
  request: ThreadMediaRequest,
): Promise<JsonValue> {
  const media = request.tool === "show_video" ? "video" : "image";
  const paths = request.tool === "show_video" ? [request.args.path] : request.args.images.map((entry) => entry.path);
  const markdown = request.tool === "show_images" ? request.markdown : undefined;

  const hash = createHash("sha256")
    .update(JSON.stringify(request.tool === "show_video" ? request : { args: request.args, markdown }))
    .digest("hex");

  return transferThreadFiles(core, source, caller, { media, paths, markdown, hash }, async (transfer) => {
    const { input, lease, files, chargedBytes } = transfer;

    const committed = await core[coreState].actions.run(
      Effect.flatMap(SqlClient.SqlClient, (sql) => commitThreadMedia(sql, input, lease, request, files, chargedBytes)),
    );

    core.hub.publishThread(
      caller.id,
      create(ui.ThreadUpdateSchema, {
        change: { case: "event", value: { seq: committed.seq, event: committed.event } },
      }),
    );

    return committed.result;
  });
}
