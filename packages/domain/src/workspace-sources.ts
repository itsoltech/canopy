import type { ui } from "@canopy/contracts";

/** Paths belong to the target worker, whose separator may differ from the client's. */
export const workspaceDirectoryName = (path: string) =>
  path
    .replace(/[/\\]+$/, "")
    .split(/[/\\]/)
    .pop() || "";

export function workspaceParentPath(path: string): string {
  const value = path.replace(/[/\\]+$/, "");
  const cut = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));

  if (cut < 0) return "";

  return cut === 0 || (cut === 2 && value[1] === ":") ? value.slice(0, cut + 1) : value.slice(0, cut);
}

/** Prefer the parent of an existing project on this worker; never suggest another computer's path. */
export function workspaceParent(worker: ui.Worker, projects: readonly ui.Project[]): string {
  const existing = projects
    .filter((p) => p.kind !== "scratch")
    .flatMap((p) => p.workspaces)
    .find((w) => w.workerId === worker.id);

  return (existing && workspaceParentPath(existing.rootPath)) || worker.homeDirectory;
}
