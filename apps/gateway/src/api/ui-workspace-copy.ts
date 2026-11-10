import type { GatewayCore } from "../core/core.ts";
import { copyManifest, copySource } from "../workspace-copy/source.ts";
import { copyTarget } from "../workspace-copy/target.ts";
import { copyWorkspace } from "../workspace-copy/copy.ts";
import { unwrap } from "./ui-errors.ts";
import { Code, ConnectError } from "@connectrpc/connect";
import { InvalidError, UnavailableError } from "../core/core-context.ts";
import { NotFound, Invalid } from "../store/index.ts";
import type { UiHandlers } from "./ui-service.ts";

export function workspaceCopyHandlers(
  core: GatewayCore,
): Pick<UiHandlers, "getWorkspaceCopyManifest" | "workspaceCopySource" | "workspaceCopyTarget" | "copyWorkspace"> {
  return {
    getWorkspaceCopyManifest: (request) => copyGuard(() => copyManifest(core, request.workspaceId)),
    workspaceCopySource: (request) => copyGuard(() => copySource(core, request)),
    workspaceCopyTarget: (request) => copyGuard(() => copyTarget(core, request)),
    copyWorkspace: async function* (request, context) {
      try {
        yield* copyWorkspace(core, request, context.signal);
      } catch (error) {
        throw copyFailure(error);
      }
    },
  };
}

async function copyGuard<A>(run: () => Promise<A>) {
  try {
    return await run();
  } catch (error) {
    throw copyFailure(error);
  }
}

/** Never log raw errors at this boundary: requests can carry private file bytes. */
function copyFailure(cause: unknown) {
  if (cause instanceof ConnectError) return cause;
  const error = unwrap(cause);

  if (error instanceof NotFound) return new ConnectError(error.message, Code.NotFound);

  if (error instanceof Invalid || error instanceof InvalidError)
    return new ConnectError(error.message, Code.InvalidArgument);

  if (error instanceof UnavailableError) return new ConnectError(error.message, Code.Unavailable);

  return new ConnectError("Workspace copy failed. Refresh the file list and retry.", Code.Internal);
}
