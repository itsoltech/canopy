import { create } from "@bufbuild/protobuf";
import { ui, type CloneProgress } from "@canopy/contracts";
import { CLONE_PROGRESS_CAPABILITY } from "@canopy/domain/release/protocol";
import { CLONE_COMMAND_TIMEOUT_MS } from "@canopy/domain/clone-progress";
import { AsyncChannel } from "@canopy/transport";
import { Code, ConnectError } from "@connectrpc/connect";
import type { GatewayCore } from "./core.ts";
import { coreAddProject } from "./core-add-project.ts";
import { coreWorkerQuery } from "./core-mentions.ts";
import { InvalidError } from "./core-context.ts";
import { toConnectError } from "../api/ui-errors.ts";

export interface CloneObserver {
  signal: AbortSignal;
  progress: (progress: CloneProgress) => void;
}

/** Same clone/registration path for unary callers and the streaming UI. */
export async function coreCloneRepository(
  core: GatewayCore,
  workerId: string,
  source: ui.AddProjectClone,
  observer?: CloneObserver,
): Promise<string> {
  const connection = core.link.connections.get(workerId);
  const capable = connection?.hello.capabilities.includes(CLONE_PROGRESS_CAPABILITY) ?? false;
  const commandId = Bun.randomUUIDv7();
  observer?.signal.throwIfAborted();
  let cancellation: Promise<void> | undefined;

  const cancel = () => {
    if (!capable || cancellation) return;
    cancellation = connection!.sendCommand({ case: "cancelCloneRepository", value: { commandId } }, 15_000).then(
      () => {},
      () => {},
    );
  };

  // sendCommand enqueues synchronously on the open connection, before a cancel can be sent.
  const result = coreWorkerQuery(
    core,
    workerId,
    {
      case: "cloneRepository",
      value: {
        parentPath: source.parentPath,
        name: source.name,
        url: source.url,
        reportProgress: capable && Boolean(observer),
      },
    },
    CLONE_COMMAND_TIMEOUT_MS,
    observer && capable ? { commandId, progress: observer.progress } : undefined,
  );

  observer?.signal.addEventListener("abort", cancel, { once: true });

  try {
    return (await result).directoryPath;
  } finally {
    observer?.signal.removeEventListener("abort", cancel);

    if (observer?.signal.aborted) cancel();
    await cancellation;
  }
}

/** Bounded transient stream; consumer cancellation reaches git through the same owner-checked operation. */
export async function* coreCloneProject(
  core: GatewayCore,
  request: ui.AddProjectRequest,
  signal: AbortSignal,
): AsyncGenerator<ui.CloneProjectUpdate> {
  if (request.source.case !== "clone") throw new InvalidError("Choose a Git URL to clone.");
  const abort = new AbortController();

  const stop = () => {
    abort.abort();
    updates.close();
  };

  const updates = new AsyncChannel<ui.CloneProjectUpdate>({
    maxItems: 8,
    overflow: () => {
      abort.abort();

      return new ConnectError("Clone updates fell behind. Check the connection and retry.", Code.ResourceExhausted);
    },
  });

  signal.addEventListener("abort", stop, { once: true });

  if (signal.aborted) stop();
  updates.push(create(ui.CloneProjectUpdateSchema, { progress: { phase: "Cloning" } }));

  const operation = coreAddProject(core, request, {
    signal: abort.signal,
    progress: (progress) => updates.push(create(ui.CloneProjectUpdateSchema, { progress })),
  }).then(
    (result) => {
      updates.push(create(ui.CloneProjectUpdateSchema, { result }));
      updates.close();
    },
    (error) => updates.close(toConnectError(error)),
  );

  try {
    yield* updates;
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
    await operation;
  }
}
