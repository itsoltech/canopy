import { error, json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { bffTarget } from "@canopy/domain/bff-target";
import { Schema } from "effect";
import { readBody } from "#lib/server/body.ts";
import { call, clientPreferencesScope } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const headers = { "cache-control": "no-store" };

const UpdateBody = Schema.Struct({
  remove: Schema.optionalKey(Schema.Boolean),
  useManaged: Schema.optionalKey(Schema.Boolean),
  origin: Schema.optionalKey(Schema.String),
  bearer: Schema.optionalKey(Schema.String),
  caPem: Schema.optionalKey(Schema.String),
});

export const GET: RequestHandler = async () => {
  return json(encode(ui.PushRelaySettingsSchema, await call((api) => api.getPushRelaySettings({}))), { headers });
};

export const PUT: RequestHandler = async ({ request, url }) => {
  const target = bffTarget();
  const scope = url.searchParams.get("gateway");
  const body = await readBody(request, UpdateBody, "Check the push relay settings and try again.");

  if (target !== bffTarget() || (scope !== null && scope !== clientPreferencesScope()))
    error(409, "The gateway changed. Reopen the relay settings and try again.");

  return json(encode(ui.PushRelaySettingsSchema, await call((api) => api.updatePushRelaySettings(body))), { headers });
};
