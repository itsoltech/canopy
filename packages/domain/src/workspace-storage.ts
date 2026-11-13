import { objectsOf, parseObject, str } from "./json.ts";
import { workspaceModule } from "./workspace-modules.ts";
import { WORKSPACE_TAB_LIMIT, type WorkspaceStore } from "./workspace.ts";

const METADATA_BYTES = 256 * 1024;

/** Per-device metadata only. File contents and drafts never enter storage. */
export function restoreWorkspace(store: WorkspaceStore, raw: string | null): void {
  if (!raw || new TextEncoder().encode(raw).byteLength > METADATA_BYTES) return;

  for (const saved of objectsOf(parseObject(raw)["views"]).slice(-30)) {
    const id = str(saved["threadId"]);

    if (!id || id.length > 1024) continue;
    const view = store.view(id);
    const sidebar = workspaceModule(str(saved["sidebar"]));
    view.sidebar = sidebar ? { module: sidebar.id, resource: str(saved["sidebarResource"]).slice(0, 1024) } : undefined;
    view.panelCollapsed = saved["panelCollapsed"] === true;
    const width = Number(saved["panelWidth"]);

    if (Number.isFinite(width) && width >= 256 && width <= 384) view.panelWidth = width;

    for (const tab of objectsOf(saved["tabs"]).slice(0, WORKSPACE_TAB_LIMIT - 1)) {
      const module = workspaceModule(str(tab["module"]));

      if (module) {
        view.openModule({
          module: module.id,
          resource: str(tab["resource"]).slice(0, 1024),
          label: str(tab["label"]).slice(0, 256),
        });
        continue;
      }

      const path = str(tab["path"]);
      const threadId = str(tab["threadId"]);

      if (!path || path.length > 4096 || threadId !== id) continue;
      view.open({ threadId, path, itemId: str(tab["itemId"]).slice(0, 1024) });
      view.keep(view.active);
    }

    const index = Number(saved["active"]);
    view.active = view.tabs[index - 1]?.id ?? "thread";
  }
}

export function workspaceMetadata(store: WorkspaceStore): string {
  const views = [...store.views.values()].slice(-30).map((view) => ({
    threadId: view.threadId,
    active: view.tabs.findIndex((tab) => tab.id === view.active) + 1,
    sidebar: view.sidebar?.module,
    sidebarResource: view.sidebar?.resource,
    panelCollapsed: view.panelCollapsed,
    panelWidth: view.panelWidth,
    tabs: view.tabs.map((tab) =>
      tab.kind === "module"
        ? { module: tab.module, resource: tab.resource, label: tab.label?.slice(0, 256) }
        : { threadId: tab.document.target.threadId, path: tab.document.path, itemId: tab.document.target.itemId ?? "" },
    ),
  }));

  while (views.length && new TextEncoder().encode(JSON.stringify({ views })).length > METADATA_BYTES) views.shift();

  return JSON.stringify({ views });
}
