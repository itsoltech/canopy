import { error, json } from "@sveltejs/kit";
import type { DescMessage, Message } from "@bufbuild/protobuf";
import { workerActions, type WorkerAction } from "#lib/features/workers/actions.ts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const methods = {
  enroll: "createWorkerEnrollment",
  "revoke-enrollment": "revokeWorkerEnrollment",
  rename: "renameWorker",
  rotate: "rotateWorkerCredential",
  revoke: "revokeWorker",
  archive: "archiveWorker",
} as const;

const isWorkerAction = (action: string): action is WorkerAction => Object.hasOwn(methods, action);

export const POST: RequestHandler = async ({ request, params }) => {
  const { action } = params;

  if (!isWorkerAction(action)) error(404, "Unknown worker action");
  const [requestSchema, responseSchema]: readonly [DescMessage, DescMessage] = workerActions[action];
  const body = await readMessage(request, requestSchema);

  const response = await call((api) =>
    // SAFETY: `workerActions[action]` holds the request and response schemas of the gateway method
    // `methods[action]`, and `body` was decoded with that request schema.
    (api[methods[action]] as (request: Message) => Promise<Message>)(body),
  );

  return json(encode(responseSchema, response), { headers: { "cache-control": "no-store" } });
};
