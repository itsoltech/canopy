/** Increase only for a breaking WorkerLink contract; additive fields do not need a bump. */
export const WORKER_LINK_PROTOCOL = 1;

/** Protocol 0 (before negotiation) is deliberately incompatible. Recovery uses UpdateService. */
export const MIN_WORKER_LINK_PROTOCOL = 1;

/** Additive WorkerLink capability: write and verify attachments before invoking a running turn's steer. */
export const STEER_ATTACHMENTS_CAPABILITY = "steer_attachments_v1";

/** Explicit owner action in an idle thread's checkout; no automatic stash or force. */
export const GIT_BRANCH_SWITCH_CAPABILITY = "git_branch_switch_v1";

/** Explicit owner action: open a thread's directory in the worker computer's file manager. */
export const REVEAL_PATH_CAPABILITY = "reveal_path";

/** Bounded transient workspace file transfers, negotiated without breaking protocol 1. */
export const WORKSPACE_COPY_CAPABILITY = "workspace_copy_v1";

/** Explicit owner actions on a thread's files: read, write, delete, open in the default app. */
export const THREAD_FILES_CAPABILITY = "thread_files_v1";

/** Frozen canopy.update.v1; never bump this for WorkerLink or application releases. */
export const UPDATE_PROTOCOL = 1;

/** Independent, additive-only canopy.link.v1 computer control channel. */
export const COMPUTER_LINK_PROTOCOL = 1;
export const MIN_COMPUTER_LINK_PROTOCOL = 1;

/** Bundled desktop BFF ↔ remote UI API. Build versions do not affect compatibility. */
export const DESKTOP_CLIENT_PROTOCOL = 1;
export const MIN_DESKTOP_CLIENT_PROTOCOL = 1;

export function workerLinkCompatible(min: number, max: number): boolean {
  return (
    Number.isInteger(min) &&
    Number.isInteger(max) &&
    min > 0 &&
    max >= min &&
    max >= MIN_WORKER_LINK_PROTOCOL &&
    min <= WORKER_LINK_PROTOCOL
  );
}
