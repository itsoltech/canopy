import { create } from "@bufbuild/protobuf";
import { connectors } from "@canopy/contracts";
import { type GatewayCore } from "../core/core.ts";
import { connectorGuard } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";
import { ConnectorTestFailure } from "../connectors/test-error.ts";

export function connectorsHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "listConnectors"
  | "saveConnectorAccount"
  | "setConnectorAccess"
  | "deleteConnectorAccount"
  | "disconnectConnector"
  | "testConnector"
  | "saveConnectorOAuthApp"
  | "beginConnectorOAuth"
  | "completeConnectorOAuth"
> {
  return {
    listConnectors: (r) => connectorGuard(() => core.connectors.list(r)),

    saveConnectorAccount: (r) =>
      connectorGuard(async () =>
        create(connectors.ConnectorAccountResponseSchema, { account: await core.connectors.save(r) }),
      ),

    setConnectorAccess: (r) =>
      connectorGuard(async () =>
        create(connectors.ConnectorAccountResponseSchema, { account: await core.connectors.access(r) }),
      ),

    deleteConnectorAccount: (r) =>
      connectorGuard(async () => {
        await core.connectors.remove(r.accountId);

        return create(connectors.DeleteConnectorAccountResponseSchema, {});
      }),

    disconnectConnector: (r) =>
      connectorGuard(async () =>
        create(connectors.ConnectorAccountResponseSchema, { account: await core.connectors.disconnect(r.accountId) }),
      ),

    testConnector: (r) =>
      connectorGuard(async () => {
        try {
          return create(connectors.TestConnectorResponseSchema, await core.connectors.test(r.accountId));
        } catch (cause) {
          if (cause instanceof ConnectorTestFailure)
            return create(connectors.TestConnectorResponseSchema, { account: cause.account });

          throw cause;
        }
      }),

    saveConnectorOAuthApp: (r) =>
      connectorGuard(async () => {
        await core.connectors.saveApp(r);

        return create(connectors.SaveConnectorOAuthAppResponseSchema);
      }),

    beginConnectorOAuth: (r) => connectorGuard(() => core.connectors.begin(r)),

    completeConnectorOAuth: async (r) => {
      try {
        return create(connectors.CompleteConnectorOAuthResponseSchema, { account: await core.connectors.complete(r) });
      } catch {
        return create(connectors.CompleteConnectorOAuthResponseSchema, {
          error: "Authorization expired, was declined or could not finish. Reconnect the account.",
        });
      }
    },
  };
}
