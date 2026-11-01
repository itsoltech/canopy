import { timingSafeEqual } from "node:crypto";
import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import { ui } from "@open-agents/contracts";

/**
 * GatewayService is called only by the web BFF (SvelteKit server), never by browsers
 * (docs/ui-api.md). The BFF authenticates with a service token; end-user authentication
 * happens in the BFF and reaches the gateway as identity metadata once multi-user lands.
 * WorkerLinkService authenticates workers itself and is not affected.
 */
export function serviceTokenAuth(token: string): Interceptor {
  if (token.length < 32) throw new Error("UI service token must have at least 32 characters");
  const expected = Buffer.from(token);
  return (next) => async (request) => {
    if (request.service.typeName === ui.GatewayService.typeName) {
      const presented = Buffer.from(/^Bearer\s+(\S+)$/i.exec(request.header.get("authorization") ?? "")?.[1] ?? "");
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        throw new ConnectError("invalid service token", Code.Unauthenticated);
      }
    }
    return next(request);
  };
}
