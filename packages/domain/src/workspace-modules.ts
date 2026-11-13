import { fileName } from "./file-references.ts";
import type { WorkspaceFile } from "./workspace-file.ts";

export const workspaceModules = [
  { id: "pull-requests", label: "Pull requests", icon: "git-fork" },
  { id: "tasks", label: "Tasks", icon: "queue-list" },
  { id: "connectors", label: "Connectors", icon: "link" },
] as const;

export type WorkspaceModuleId = (typeof workspaceModules)[number]["id"];

export interface WorkspaceModuleTarget {
  readonly module: WorkspaceModuleId;
  readonly resource: string;
  readonly label?: string;
}

export interface WorkspaceModuleTab extends WorkspaceModuleTarget {
  readonly kind: "module";
  readonly id: string;
  readonly preview: false;
}

export interface WorkspaceTab {
  readonly kind: "file";
  readonly id: string;
  readonly document: WorkspaceFile;
  preview: boolean;
}

export type WorkspaceEntry = WorkspaceTab | WorkspaceModuleTab;

export function workspaceModule(id: string) {
  return workspaceModules.find((module) => module.id === id);
}

export const fileTab = (tab: WorkspaceEntry): tab is WorkspaceTab => tab.kind === "file";
export const tabDirty = (tab: WorkspaceEntry) => tab.kind === "file" && tab.document.dirty;
export const tabBusy = (tab: WorkspaceEntry) => tab.kind === "file" && tab.document.busy;

export const tabPath = (tab: WorkspaceEntry) =>
  tab.kind === "file"
    ? tab.document.path
    : tab.label ||
      (tab.resource
        ? tab.module === "pull-requests"
          ? "Pull request"
          : "Task output"
        : workspaceModule(tab.module)?.label) ||
      "Module";

export const tabName = (tab: WorkspaceEntry) => (tab.kind === "file" ? fileName(tab.document.path) : tabPath(tab));
