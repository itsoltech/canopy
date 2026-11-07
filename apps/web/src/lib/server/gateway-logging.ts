import type { Transport } from "@connectrpc/connect";
import { gatewayFailure } from "./gateway-errors.ts";

/** Descriptor names and elapsed time only: never log request metadata, payloads or transport causes. */
export function logGatewayFailures(transport: Transport): Transport {
  const unary: Transport["unary"] = async (...args) => {
    const started = performance.now();

    try {
      return await transport.unary(...args);
    } catch (cause) {
      const failure = gatewayFailure(cause);

      if (failure.status >= 500)
        console.error("gateway call failed", {
          method: args[0].name,
          durationMs: Math.round(performance.now() - started),
          ...failure,
        });
      throw cause;
    }
  };

  return { unary, stream: transport.stream.bind(transport) };
}
