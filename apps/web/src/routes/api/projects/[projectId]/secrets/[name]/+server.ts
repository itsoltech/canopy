import { error, isHttpError, json } from "@sveltejs/kit";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import { ui } from "@canopy/contracts";
import { readBody } from "#lib/server/body.ts";
import { call, gateway } from "#lib/server/gateway.ts";
import { gatewayFailure } from "#lib/server/gateway-errors.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Struct({ value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32768)) });
const noStore = { "cache-control": "no-store" };

/** Gateway validation answers (name, limits, project) are public; transport causes can hold the request. */
const answered = new Set([
  Code.InvalidArgument,
  Code.NotFound,
  Code.PermissionDenied,
  Code.FailedPrecondition,
  Code.ResourceExhausted,
  Code.Unimplemented,
]);

/** Write only: the value is never logged, cached or echoed back, also not in errors. */
export const PUT: RequestHandler = async ({ request, params }) => {
  const retry = "Could not save the secret. Enter it again to retry.";
  let failure = { status: 502, message: retry };

  try {
    const body = await readBody(request, Body, retry);

    const response = await gateway().putProjectSecret({
      projectId: params.projectId,
      name: params.name,
      value: body.value,
    });

    return json(encode(ui.PutProjectSecretResponseSchema, response), { headers: noStore });
  } catch (cause) {
    if (cause instanceof ConnectError && cause.cause === undefined && answered.has(cause.code)) {
      const known = gatewayFailure(cause);

      failure = { status: known.status, message: known.message };
    } else if (isHttpError(cause)) failure = { status: cause.status, message: retry };
  }

  error(failure.status, failure.message);
};

/** Removes the secret from the project (docs/secrets.md). */
export const DELETE: RequestHandler = async ({ params }) => {
  await call((api) => api.deleteProjectSecret({ projectId: params.projectId, name: params.name }));

  return json({}, { headers: noStore });
};
