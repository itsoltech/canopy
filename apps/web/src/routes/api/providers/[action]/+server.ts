import { error, json } from "@sveltejs/kit";
import type { DescMessage } from "@bufbuild/protobuf";
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
} as const satisfies Record<ProviderAction, string>;

export const POST: RequestHandler = async ({ params, request }) => {
  const action = params.action as ProviderAction;

  if (!Object.hasOwn(methods, action)) error(404, "unknown action");
  const [requestSchema, responseSchema] = providerActions[action] as readonly [DescMessage, DescMessage];
  const body = await readMessage(request, requestSchema);
  const method = methods[action];

  // Refresh waits for the workers to check again (up to a minute).
  const response = await call((api) =>
    (api[method] as (r: unknown, o?: unknown) => Promise<never>)(
      body,
      action === "refresh" || action === "login" ? { timeoutMs: 70_000 } : undefined,
    ),
  );

  return json(encode(responseSchema, response));
};
