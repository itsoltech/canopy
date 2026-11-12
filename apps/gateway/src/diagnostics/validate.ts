import type { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { diagnosticsSorts } from "@canopy/domain/diagnostics";
import { RPC_METHODS, LINKED_METHODS, COMMAND_METHODS, MAX_METHODS } from "./registry.ts";

const keys = new Set(
  [...RPC_METHODS, ...LINKED_METHODS, ...COMMAND_METHODS].map((method) => `${method.layer}:${method.name}`),
);

export function validateDiagnostics(request: ui.ComputerDiagnosticsRequest, internal = false) {
  if (
    (request.sortBy && !diagnosticsSorts.some((sort) => sort.value === request.sortBy)) ||
    (request.callKind && !["unary", "stream"].includes(request.callKind)) ||
    request.methodKeys.length > 32 ||
    request.methodKeys.some((key) => !keys.has(key)) ||
    request.offset > MAX_METHODS ||
    (!internal && request.limit > 32)
  )
    throw new ConnectError("Choose an available call view within the page budget", Code.InvalidArgument);
}
