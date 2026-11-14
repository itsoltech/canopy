import { error, json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { compileVisualExport, visualToken } from "@canopy/domain/visual-compiler";
import { fileResponse } from "#lib/server/files.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/**
 * A version of a thread visual (GetVisual, owner-scoped by the gateway). `?download` returns the standalone HTML
 * export as an attachment: the pinned kit, the spec and the CSP, in its initial state, with no host bridge.
 */
export const GET: RequestHandler = async ({ params, url }) => {
  const version = Number(url.searchParams.get("version") ?? 0);

  // uint32 on the wire; anything else is the caller's mistake, not a gateway failure.
  if (!Number.isInteger(version) || version < 0 || version > 0xffff_ffff) error(400, "Invalid version");

  const response = await call((api) =>
    api.getVisual({ threadId: params.threadId, visualId: params.visualId, version }),
  );

  if (!url.searchParams.has("download")) return json(encode(ui.GetVisualResponseSchema, response));
  const exported = response.visual && compileVisualExport(response.visual, response.specJson, visualToken());

  if (!exported) error(409, "This visual can't be exported");

  return fileResponse(new TextEncoder().encode(exported.html), "text/html", { name: exported.name, download: true });
};
