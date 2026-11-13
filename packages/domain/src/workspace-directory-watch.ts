import { ThreadFileChangeKind as Kind } from "@canopy/contracts";
import type { WorkspaceDirectory } from "./workspace-directory.ts";
import { workspaceChanges } from "./workspace-changes.ts";

export function observeWorkspaceDirectory(tree: WorkspaceDirectory) {
  let stop = () => {};
  let key = "";

  const update = () => {
    const directories = ["", ...tree.expanded].slice(0, 31);
    const next = JSON.stringify(directories);

    if (next === key) return;
    key = next;
    stop();
    stop = workspaceChanges(tree.cache.store).retain(tree.threadId, {
      directories,
      files: [],
      update: (event) => {
        if (event.changes.some((change) => change.kind === Kind.ROOT_CHANGED)) {
          tree.clear();
          tree.node("").error = "The working directory changed. Reopen Files to continue.";
          tree.notify();
        } else if (event.revalidateRequired) tree.invalidate();
        else
          tree.invalidate(
            event.changes.filter((change) => change.kind === Kind.DIRECTORY_INVALIDATED).map((change) => change.path),
          );
      },
      status: (message) => {
        tree.watchStatus = message;
        tree.notify();
      },
    });
  };

  const unsubscribe = tree.subscribe(update);
  update();

  return () => {
    unsubscribe();
    stop();
  };
}
