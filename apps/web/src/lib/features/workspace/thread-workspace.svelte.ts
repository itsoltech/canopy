import { untrack } from "svelte";
import type { Workspace, WorkspaceTab } from "@canopy/domain/workspace";
import { provideWorkspace, workspaceStore, workspaceVersion } from "./workspace.svelte.ts";

export class ThreadWorkspace {
  closing = $state<WorkspaceTab[]>([]);
  #closingView: Workspace | undefined;

  constructor(readonly threadId: () => string) {
    provideWorkspace(() => this.view);
    $effect(() => {
      const id = threadId();
      const view = untrack(() => workspaceStore.view(id));
      untrack(() => workspaceStore.touch(view));

      return () => view.current?.document.cancel();
    });
  }

  get view() {
    void workspaceVersion();

    return workspaceStore.view(this.threadId());
  }

  get current() {
    return this.view.current;
  }

  close(id: string): void {
    this.closeTabs([id]);
  }

  closeOthers(id: string): void {
    this.closeTabs(this.view.tabs.filter((tab) => tab.id !== id).map((tab) => tab.id));
  }

  private closeTabs(ids: string[]): void {
    const tabs = this.view.tabs.filter((tab) => ids.includes(tab.id) && !tab.document.busy);

    if (tabs.some((tab) => tab.document.dirty)) {
      this.closing = tabs;
      this.#closingView = this.view;
    } else for (const tab of tabs) this.view.close(tab.id);
  }

  async confirmClose(save: boolean): Promise<void> {
    for (const tab of this.closing) {
      if (tab.document.dirty) {
        if (save) {
          if (!(await tab.document.save())) return;
        } else tab.document.discard();
      }

      this.#closingView?.close(tab.id);
    }

    this.closing = [];
  }
}
