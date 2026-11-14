import { error, json } from "@sveltejs/kit";
import type { DescMessage, Message } from "@bufbuild/protobuf";
import type { CallOptions } from "@connectrpc/connect";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { providerActions, type ProviderAction } from "#lib/features/providers/instances.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/**
 * Changes to provider instances (docs/ui-api.md): save, delete, workers (where it runs), worker (on/off and overrides
 * on one worker), models, refresh, login. A stale `expectedRevision` is a 409; an instance in use cannot be deleted (409).
 */
const methods = {
  save: "saveProviderInstance",
  delete: "deleteProviderInstance",
  workers: "setInstanceWorkers",
  worker: "setInstanceWorker",
  models: "setInstanceModels",
  refresh: "refreshProviders",
  login: "startProviderLogin",
  complete: "completeProviderLogin",
  logout: "logoutProvider",
  move: "moveInstanceToProxy",
} as const satisfies Record<ProviderAction, string>;

const isProviderAction = (action: string): action is ProviderAction => Object.hasOwn(methods, action);

export const POST: RequestHandler = async ({ params, request }) => {
  const { action } = params;

  if (!isProviderAction(action)) error(404, "unknown action");
  const [requestSchema, responseSchema]: readonly [DescMessage, DescMessage] = providerActions[action];
  const body = await readMessage(request, requestSchema);
  const method = methods[action];

  // Refresh waits for the workers to check again (up to a minute).
  const response = await call((api) =>
    // SAFETY: `providerActions[action]` holds the request and response schemas of the gateway method
    // `methods[action]`, and `body` was decoded with that request schema.
    (api[method] as (request: Message, options?: CallOptions) => Promise<Message>)(
      body,
      action === "refresh" || action === "login" ? { timeoutMs: 70_000 } : undefined,
    ),
  );

  return json(encode(responseSchema, response));
};
