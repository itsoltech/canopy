import { type DescMethod } from "@bufbuild/protobuf";
import { computerLink, ui, update, CommandSchema, WorkerEnrollmentService, WorkerLinkService } from "@canopy/contracts";
import { SERVED } from "../computers/remote-policy.ts";

export { diagnosticMethodId as methodId } from "@canopy/domain/diagnostics";

import { diagnosticMethodId as methodId } from "@canopy/domain/diagnostics";

export type RegisteredMethod = { id: number; name: string; layer: string; stream: boolean; interactive: boolean };

export const MAX_METHODS = 512;

/** Stable across additive contracts; descriptor collisions are a startup error, never merged series. */
export function registered(method: DescMethod, layer = "rpc"): RegisteredMethod {
  const name = `${method.parent.typeName}/${method.name}`;

  return {
    id: methodId(`${layer}:${name}`),
    name,
    layer,
    stream: method.methodKind !== "unary",
    interactive: method.methodKind === "unary" && !/Import|Update|Install|Generate|Clone|Move|Ssh/.test(method.name),
  };
}

export const RPC_METHODS = [
  ui.GatewayService,
  WorkerLinkService,
  WorkerEnrollmentService,
  update.UpdateService,
  computerLink.ComputerLinkService,
].flatMap((service) => service.methods.map((method) => registered(method)));

export const COMMAND_METHODS = CommandSchema.fields.flatMap((field) =>
  field.oneof?.name === "kind"
    ? [
        {
          id: methodId(`command:${field.localName}`),
          name: `worker.command/${field.localName}`,
          layer: "command",
          stream: false,
          interactive: false,
        },
      ]
    : [],
);

export const LINKED_METHODS = [
  ...ui.GatewayService.methods,
  ...computerLink.DiagnosticsService.methods,
  ...computerLink.ThreadMirrorService.methods,
  ...computerLink.LinkedAgentsService.methods,
  ...computerLink.ConfigSyncService.methods,
  ...computerLink.ComputerMoveService.methods,
  ...computerLink.ComputerUpdateService.methods,
].flatMap((method) => (SERVED.has(method.name) ? [registered(method, "home")] : []));
