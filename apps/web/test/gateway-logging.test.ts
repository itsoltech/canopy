import { expect, test, spyOn } from "bun:test";
import { createClient, Code, ConnectError, type Transport } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { logGatewayFailures } from "../src/lib/server/gateway-logging.ts";

test("BFF failure diagnostics identify the RPC and time without request data or transport secrets", async () => {
  const logged = spyOn(console, "error").mockImplementation(() => {});

  const transport: Transport = {
    unary: async () => {
      throw new ConnectError(
        "https://private.example token=private-value",
        Code.DeadlineExceeded,
        {
          authorization: "Bearer private-value",
        },
        [],
        new Error("private transport cause"),
      );
    },
    stream: async () => {
      throw new Error("unused");
    },
  };

  const client = createClient(ui.GatewayService, logGatewayFailures(transport));

  try {
    const cause = await client.listConnectors({ threadId: "private request payload" }).catch(ConnectError.from);
    expect(cause).toBeInstanceOf(ConnectError);
    expect(logged.mock.calls).toHaveLength(1);
    expect(logged.mock.calls[0]).toEqual([
      "gateway call failed",
      {
        method: "ListConnectors",
        durationMs: expect.any(Number),
        status: 504,
        message: "The gateway request timed out",
      },
    ]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain("private");
  } finally {
    logged.mockRestore();
  }
});
