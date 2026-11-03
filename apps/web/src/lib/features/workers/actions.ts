import { create, type DescMessage, type MessageInitShape, type MessageShape } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";

export const workerActions = {
  enroll: [ui.CreateWorkerEnrollmentRequestSchema, ui.CreateWorkerEnrollmentResponseSchema],
  "revoke-enrollment": [ui.RevokeWorkerEnrollmentRequestSchema, ui.WorkerOperationResponseSchema],
  rename: [ui.RenameWorkerRequestSchema, ui.WorkerOperationResponseSchema],
  rotate: [ui.WorkerRequestSchema, ui.RotateWorkerCredentialResponseSchema],
  revoke: [ui.WorkerRequestSchema, ui.WorkerOperationResponseSchema],
  archive: [ui.WorkerRequestSchema, ui.WorkerOperationResponseSchema],
} as const;
export type WorkerAction = keyof typeof workerActions;
export async function workerAction<K extends WorkerAction>(action: K, input: MessageInitShape<(typeof workerActions)[K][0]>): Promise<MessageShape<(typeof workerActions)[K][1]>> {
  const [requestSchema, responseSchema] = workerActions[action];
  return decode(responseSchema as DescMessage, await requestJson("POST", `/api/workers/manage/${action}`, encode(requestSchema as DescMessage, create(requestSchema as DescMessage, input as never)))) as never;
}

/** POSIX shells on both Linux and macOS; user-controlled URLs/paths never become shell syntax. */
export const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
export function enrollmentCommand(input: { origin: string; gatewayUrl: string; token: string; name: string; releaseUrl?: string }) {
  const fallback = input.releaseUrl ? ` --release-url ${shellQuote(input.releaseUrl)} --checksum-url ${shellQuote(input.releaseUrl.replace(/\/[^/]+$/, "/checksums.txt"))}` : "";
  return `curl -fsSL ${shellQuote(`${input.origin}/install/worker.sh`)} | sh -s -- --gateway ${shellQuote(input.gatewayUrl)} --token ${shellQuote(input.token)} --name ${shellQuote(input.name)}${fallback}`;
}
