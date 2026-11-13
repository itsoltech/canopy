import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import { targetsLinkedComputer } from "./gateway-transport.ts";
import { bffMeasurements } from "./diagnostics.ts";

/** Explicit call-site budgets win; a linked call gets time to return its own result. */
export function gatewayDeadlines(transport: Transport): Transport {
  const unary: Transport["unary"] = async (...args) => {
    const method = args[0];
    const started = bffMeasurements.enabled && method.name !== "SubmitDiagnostics" ? performance.now() : 0;
    const read = /^(Get|List|Search|Read|Preview)/.test(method.name);
    const linked = targetsLinkedComputer(method.input, create(method.input, args[4]));
    const budget = method.name === "SendMessage" ? 10_000 : read ? (linked ? 15_000 : 10_000) : 35_000;

    try {
      return await transport.unary(method, args[1], args[2] ?? budget, args[3], args[4], args[5]);
    } finally {
      if (started) bffMeasurements.record(linked ? 7 : 6, performance.now() - started);
    }
  };

  return { unary, stream: transport.stream.bind(transport) };
}
