import { error, json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { Schema } from "effect";
import { readBody } from "#lib/server/body.ts";
import { call, hasGatewayServiceAccess } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const headers = { "cache-control": "no-store" };

const UpdateBody = Schema.Struct({
  remove: Schema.optionalKey(Schema.Boolean),
  origin: Schema.optionalKey(Schema.String),
  bearer: Schema.optionalKey(Schema.String),
  caPem: Schema.optionalKey(Schema.String),
});

function requireGatewayServiceAccess() {
  if (!hasGatewayServiceAccess()) error(403, "Open the gateway’s own settings to configure its push relay.");
}

export const GET: RequestHandler = async () => {
  requireGatewayServiceAccess();

  return json(encode(ui.PushRelaySettingsSchema, await call((api) => api.getPushRelaySettings({}))), { headers });
};

export const PUT: RequestHandler = async ({ request }) => {
  requireGatewayServiceAccess();
  const body = await readBody(request, UpdateBody, "Check the push relay settings and try again.");

  // The controller can switch the BFF's gateway while the body is being read.
  requireGatewayServiceAccess();

  return json(encode(ui.PushRelaySettingsSchema, await call((api) => api.updatePushRelaySettings(body))), { headers });
};
