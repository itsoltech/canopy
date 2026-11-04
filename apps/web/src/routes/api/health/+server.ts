import { json } from "@sveltejs/kit";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import type { RequestHandler } from "./$types";

/** Liveness of the BFF itself (Docker HEALTHCHECK, load balancers); it does not call the gateway. */
export const GET: RequestHandler = () =>
  json({ status: "ok", version: CANOPY_VERSION }, { headers: { "cache-control": "no-store" } });
