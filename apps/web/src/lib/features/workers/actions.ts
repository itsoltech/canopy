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
export function enrollmentCommand(input: { gatewayUrl: string; token: string; repository: string; checkout: string; source: "clone" | "existing"; os: "linux" | "darwin" }) {
  const getSource = input.source === "clone"
    ? `git clone ${shellQuote(input.repository || "<YOUR_CANOPY_REPOSITORY_URL>")} "$HOME/canopy"\ncd "$HOME/canopy"`
    : `cd ${shellQuote(input.checkout || "/path/to/canopy")}`;
  return `# ${input.os === "darwin" ? "macOS" : "Linux"}: run as your regular user, in bash or zsh\n(\nset -e\nif ! command -v bun >/dev/null 2>&1; then\n  curl -fsSL https://bun.com/install | bash\nfi\nexport PATH="$HOME/.bun/bin:$PATH"\n${getSource}\nbun install\nbun apps/worker/src/main.ts enroll --gateway ${shellQuote(input.gatewayUrl)} --token ${shellQuote(input.token)}\nbun apps/worker/src/main.ts\n)`;
}
