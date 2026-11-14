import { error, json } from "@sveltejs/kit";
import type { DescMessage, Message } from "@bufbuild/protobuf";
import type { CallOptions } from "@connectrpc/connect";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { proxyActions, type ProxyAction } from "#lib/features/proxies/proxies.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const methods = {
  save: "saveProxy",
  delete: "deleteProxy",
  test: "testProxy",
  accounts: "refreshProxyAccounts",
} as const;

const isAction = (value: string): value is ProxyAction => Object.hasOwn(methods, value);

export const POST: RequestHandler = async ({ params, request }) => {
  if (!isAction(params.action)) error(404, "unknown proxy action");
  const [input, output]: readonly [DescMessage, DescMessage] = proxyActions[params.action];
  const body = await readMessage(request, input);
  const method = methods[params.action];

  const response = await call((api) =>
    // SAFETY: methods and proxyActions pair this method with the schema used to decode body.
    (api[method] as (request: Message, options?: CallOptions) => Promise<Message>)(body, {
      ...((method === "testProxy" || method === "refreshProxyAccounts") && { timeoutMs: 15_000 }),
    }),
  );

  return json(encode(output, response));
};
