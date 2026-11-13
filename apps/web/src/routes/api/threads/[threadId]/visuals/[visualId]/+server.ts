import { error, json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { compileVisual, visualToken } from "@canopy/domain/visual-compiler";
import { parseVisualSpec, REVOKED_VISUAL_KITS } from "@canopy/domain/visuals";
import { Result } from "effect";
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
  const visual = response.visual;
  const decoded = parseVisualSpec(response.specJson);

  if (!visual || Result.isFailure(decoded) || REVOKED_VISUAL_KITS.has(visual.kitVersion))
    error(409, "This visual can't be exported");

  const html = compileVisual(decoded.success, {
    title: visual.title,
    mode: "export",
    nonce: visualToken(),
    instance: "export",
  });

  const name = `${
    visual.title
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "visual"
  }-v${visual.version}.html`;

  return fileResponse(new TextEncoder().encode(html), "text/html", { name, download: true });
};
