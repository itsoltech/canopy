import { untrack } from "svelte";
import type { Workspace, WorkspaceTab } from "@canopy/domain/workspace";
import { fileTab, tabBusy } from "@canopy/domain/workspace-modules";
import { provideWorkspace, workspaceStore, workspaceVersion } from "./workspace.svelte.ts";

export class ThreadWorkspace {
  width = $state(0);
  rem = $state(16);
  closing = $state<WorkspaceTab[]>([]);
  #closingView: Workspace | undefined;
  #closingIds: string[] = [];

  constructor(readonly threadId: () => string) {
    provideWorkspace(() => this.view);
    $effect(() => {
      const id = threadId();
      const view = untrack(() => workspaceStore.view(id));
      untrack(() => workspaceStore.touch(view));

      return () => view.currentFile?.document.cancel();
    });
  }

  get view() {
    void workspaceVersion();

    return workspaceStore.view(this.threadId());
  }

  get current() {
    return this.view.current;
  }

  get wide() {
    return this.width >= 56.75 * this.rem;
  }

  close(id: string): void {
    this.closeTabs([id]);
  }

  closeOthers(id: string): void {
    this.closeTabs(this.view.tabs.filter((tab) => tab.id !== id).map((tab) => tab.id));
  }

  togglePanel(sheet: () => void): void {
    if (this.wide) this.view.collapsePanel(!this.view.panelCollapsed);
    else sheet();
  }

  private closeTabs(ids: string[]): void {
    const entries = this.view.tabs.filter((tab) => ids.includes(tab.id) && !tabBusy(tab));
    const tabs = entries.filter(fileTab);

    if (tabs.some((tab) => tab.document.dirty)) {
      this.closing = tabs;
      this.#closingView = this.view;
      this.#closingIds = entries.map((entry) => entry.id);
    } else for (const tab of entries) this.view.close(tab.id);
  }

  async confirmClose(save: boolean): Promise<void> {
    for (const tab of this.closing) {
      if (tab.document.dirty) {
        if (save) {
          if (!(await tab.document.save())) return;
        } else tab.document.discard();
      }
    }

    for (const id of this.#closingIds) this.#closingView?.close(id);
    this.#closingIds = [];

    this.closing = [];
  }
}
