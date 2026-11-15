import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { z } from "zod";
import type { GatewayCore } from "../core/core.ts";
import { InvalidError } from "../core/core-context.ts";
import { copyAttempt, type CopyAttemptProgress } from "./attempt.ts";

const active = new WeakMap<GatewayCore, Set<string>>();

/** Copies a client stream keeps open here at once; background copies have their own limit (jobs.ts). */
const STREAMED_COPIES = 2;

export const progressMessage = (progress: CopyAttemptProgress) => create(ui.WorkspaceCopyProgressSchema, progress);

/**
 * The client-held copy (CopyWorkspace): progress while the stream is open, cancelled with it. Updates coalesce:
 * a slow reader gets the latest state, never a backlog.
 */
export async function* copyWorkspace(core: GatewayCore, request: ui.CopyWorkspaceRequest, signal: AbortSignal) {
  if (!z.uuid().safeParse(request.transferKey).success) throw new InvalidError("Invalid transfer identifier.");
  const running = active.get(core) ?? new Set<string>();

  if (running.has(request.transferKey) || running.size >= STREAMED_COPIES)
    throw new InvalidError("Two copies are already running. Wait for one to finish.");
  active.set(core, running);
  running.add(request.transferKey);
  let latest: CopyAttemptProgress | undefined;
  let wake: (() => void) | undefined;
  let ended = false;

  const attempt = copyAttempt(
    core,
    {
      sourceRef: request.sourceRef,
      targetRef: request.targetRef,
      projectRef: request.projectRef,
      transferKey: request.transferKey,
      parentPath: request.parentPath,
      name: request.name,
      selection: {
        manifestToken: request.manifestToken,
        paths: request.paths,
        ...(request.ignoredSelection && { ignoredPaths: request.ignoredSelection.paths }),
        confirmedSecrets: request.confirmedSecrets,
      },
    },
    signal,
    (progress) => {
      latest = progress;
      wake?.();
    },
    { keepStaged: false },
  ).finally(() => {
    running.delete(request.transferKey);
    ended = true;
    wake?.();
  });

  // Rejections surface below through `attempt`; this keeps an early one from being reported as unhandled.
  attempt.catch(() => {});

  while (!ended) {
    if (!latest) await new Promise<void>((done) => (wake = done));
    wake = undefined;

    if (latest && !ended) {
      const next = latest;
      latest = undefined;
      yield progressMessage(next);
    }
  }

  yield progressMessage(await attempt);
}
