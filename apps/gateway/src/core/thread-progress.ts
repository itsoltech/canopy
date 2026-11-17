import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import type { GatewayCore } from "./core.ts";
import { toConnectError } from "../api/ui-errors.ts";

const labels = {
  check_workspace: "Check workspace",
  fetch_remote: "Fetch remote branch",
  create_worktree: "Create worktree",
  prepare_message: "Prepare message",
  start_thread: "Start thread",
};

export type CreationStep = keyof typeof labels;

export type CreationStatus = "pending" | "running" | "completed" | "skipped" | "failed";

export type CreationProgress = (step: CreationStep, status: CreationStatus, detail?: string) => void;

export function creationEvent(step: CreationStep, status: CreationStatus, detail = ""): ui.CreateThreadProgress {
  return create(ui.CreateThreadProgressSchema, { step, label: labels[step], status, detail });
}

/** Creation continues after a subscriber disconnects; every rejection is handled here. */
export async function* createThreadProgress(core: GatewayCore, request: ui.CreateThreadRequest, signal: AbortSignal) {
  const events = new AsyncChannel<ui.CreateThreadProgress>();
  let active: CreationStep = "check_workspace";

  const progress: CreationProgress = (step, status, detail) => {
    if (status === "running") active = step;
    events.push(creationEvent(step, status, detail));
  };

  const stop = () => events.close();
  signal.addEventListener("abort", stop, { once: true });

  if (signal.aborted) stop();

  void (async () => {
    try {
      const thread = await core.createThread(request, undefined, true, undefined, progress);
      events.push(create(ui.CreateThreadProgressSchema, { ...creationEvent("start_thread", "completed"), thread }));
    } catch (error) {
      events.push(creationEvent(active, "failed", toConnectError(error).rawMessage));
    } finally {
      events.close();
    }
  })();

  try {
    yield* events;
  } finally {
    signal.removeEventListener("abort", stop);
    events.close();
  }
}
