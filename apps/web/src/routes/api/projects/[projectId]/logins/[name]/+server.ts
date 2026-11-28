import { error, isHttpError, json } from "@sveltejs/kit";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import { ui } from "@canopy/contracts";
import { readBody } from "#lib/server/body.ts";
import { gateway } from "#lib/server/gateway.ts";
import { gatewayFailure } from "#lib/server/gateway-errors.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const Body = Schema.Struct({
  websites: Schema.Array(Schema.String.check(Schema.isMaxLength(2048))).check(Schema.isMaxLength(20)),
  username: Schema.String.check(Schema.isMaxLength(4096)),
  showUsername: Schema.Boolean,
  notes: Schema.String.check(Schema.isMaxLength(2000)),
  askEachTime: Schema.Boolean,
  outsideBrowser: Schema.Boolean,
  password: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192))),
  oneTimeCodeSetup: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
});

const noStore = { "cache-control": "no-store" };

const answered = new Set([
  Code.InvalidArgument,
  Code.NotFound,
  Code.PermissionDenied,
  Code.FailedPrecondition,
  Code.ResourceExhausted,
  Code.Unimplemented,
]);

/** Write only: the password and setup key are never logged, cached or echoed back, also not in errors. */
export const PUT: RequestHandler = async ({ request, params }) => {
  const retry = "Could not save the login. Enter the password again to retry.";
  let failure = { status: 502, message: retry };

  try {
    const { password, oneTimeCodeSetup, ...login } = await readBody(request, Body, retry);

    const response = await gateway().putProjectLogin({
      projectId: params.projectId,
      name: params.name,
      login: create(ui.ProjectLoginSchema, { ...login, websites: [...login.websites] }),
      ...(password !== undefined && { password }),
      ...(oneTimeCodeSetup !== undefined && { oneTimeCodeSetup }),
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
