import { error, json } from "@sveltejs/kit";
import { ui } from "@open-agents/contracts";
import { requireSameOrigin } from "#lib/server/files.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Hard ceiling of one upload body here; the gateway applies its own (smaller, configurable) limit. */
const MAX_BODY = 200 * 1024 ** 2;

/**
 * Upload of one file (docs/ui-api.md, "Załączniki"): the raw bytes as the body, its name in `x-file-name`
 * (URI-encoded). The browser's type is ignored: the gateway types the file by its content.
 */
export const POST: RequestHandler = async ({ request, url }) => {
  requireSameOrigin(request, url);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY) error(413, "The file is too large");
  let name = "attachment";
  try {
    name = decodeURIComponent(request.headers.get("x-file-name") ?? "") || name;
  } catch {
    error(400, "Bad file name");
  }
  const data = new Uint8Array(await request.arrayBuffer());
  const response = await call((api) => api.uploadAttachment({ name, data }, { timeoutMs: 60_000 }));
  return json(encode(ui.AttachmentSchema, response.attachment!));
};
