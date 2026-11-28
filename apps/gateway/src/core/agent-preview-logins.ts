import { create } from "@bufbuild/protobuf";
import { AgentPreviewInputSchema, AgentTool, type AgentPreviewInput } from "@canopy/contracts";
import { oneTimeCode, parseOneTimeCodeSetup } from "@canopy/domain/one-time-codes";
import { PROJECT_LOGINS, type ProjectLoginValue } from "@canopy/domain/project-logins";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import type { WorkerConnection } from "../worker-link/index.ts";
import { coreRun } from "./core-broadcast.ts";
import { coreState } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";

const LoginValue = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      username: Schema.String,
      password: Schema.String,
      one_time_code_setup: Schema.optionalKey(Schema.String),
      websites: Schema.Array(Schema.String),
      hide_username: Schema.Boolean,
    }),
  ),
);

async function fieldText(
  login: ProjectLoginValue,
  field: string,
): Promise<{ text: string; masked: boolean; expiresAt?: number }> {
  if (field === "username") return { text: login.username, masked: login.hide_username };

  if (field === "password") return { text: login.password, masked: true };
  const setup = login.one_time_code_setup && parseOneTimeCodeSetup(login.one_time_code_setup);

  if (!setup)
    throw new ConnectError(
      `Login ${login.name} has no one-time code. Add a setup key in project settings.`,
      Code.FailedPrecondition,
    );

  const current = await oneTimeCode(setup);

  return { text: current.code, masked: false, expiresAt: current.expiresAt };
}

/**
 * The owner fills a login field in Browser Preview. Only the gateway can read the login, so it swaps the request
 * for the value; the worker types it only on one of the login's websites and keeps it masked afterwards.
 */
export async function resolvePreviewLogins(
  core: GatewayCore,
  preview: { threadId: string; tool: AgentTool; worker: WorkerConnection },
  inputs: AgentPreviewInput[],
): Promise<AgentPreviewInput[]> {
  if (!inputs.some((input) => input.kind === "login")) return inputs;

  if (preview.tool !== AgentTool.BROWSER || !preview.worker.hello.capabilities.includes(PROJECT_LOGINS))
    throw new ConnectError("Update Canopy on this computer to enter project logins", Code.FailedPrecondition);
  const { userId } = core[coreState].options;

  return Promise.all(
    inputs.map(async (input) => {
      if (input.kind !== "login") return input;
      const raw = await coreRun(core, (store) => store.projectLoginValue(userId, preview.threadId, input.text));

      if (!raw)
        throw new ConnectError(
          `Login ${input.text} is not in this thread’s project. Check its project settings.`,
          Code.NotFound,
        );
      const parsed = LoginValue(raw);
      const login: ProjectLoginValue = { ...parsed, websites: [...parsed.websites] };
      const { text, masked, expiresAt } = await fieldText(login, input.key);

      return create(AgentPreviewInputSchema, {
        kind: "login-text",
        login: {
          name: login.name,
          text,
          websites: login.websites,
          masked,
          field: input.key,
          expiresAtMs: BigInt(expiresAt ?? 0),
        },
      });
    }),
  );
}
