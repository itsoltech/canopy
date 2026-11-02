import { error, json } from "@sveltejs/kit";
import type { DescMessage } from "@bufbuild/protobuf";
import { workerActions, type WorkerAction } from "#lib/features/workers/actions.ts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const methods = { enroll: "createWorkerEnrollment", "revoke-enrollment": "revokeWorkerEnrollment", rename: "renameWorker", rotate: "rotateWorkerCredential", revoke: "revokeWorker", archive: "archiveWorker" } as const;
export const POST: RequestHandler = async ({ request, params }) => {
  const action = params.action as WorkerAction;
  if (!Object.hasOwn(methods, action)) error(404, "Unknown worker action");
  const [requestSchema, responseSchema] = workerActions[action] as readonly [DescMessage, DescMessage];
  const body = await readMessage(request, requestSchema);
  const response = await call((api) => (api[methods[action]] as (r: unknown) => Promise<never>)(body));
  return json(encode(responseSchema, response), { headers: { "cache-control": "no-store" } });
};
