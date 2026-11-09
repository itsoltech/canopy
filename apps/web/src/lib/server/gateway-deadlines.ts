import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import { targetsLinkedComputer } from "./gateway-transport.ts";

/** Explicit call-site budgets win; a linked call gets time to return its own result. */
export function gatewayDeadlines(transport: Transport): Transport {
  const unary: Transport["unary"] = (...args) => {
    const method = args[0];
    const read = /^(Get|List|Search|Read|Preview)/.test(method.name);
    const linked = targetsLinkedComputer(method.input, create(method.input, args[4]));
    const budget = method.name === "SendMessage" ? 10_000 : read ? (linked ? 15_000 : 10_000) : 35_000;

    return transport.unary(method, args[1], args[2] ?? budget, args[3], args[4], args[5]);
  };

  return { unary, stream: transport.stream.bind(transport) };
}
