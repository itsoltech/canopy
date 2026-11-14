import { untrack } from "svelte";
import type { Workspace, WorkspaceTab } from "@canopy/domain/workspace";
import { fileTab, tabBusy, tabDirty } from "@canopy/domain/workspace-modules";
import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
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
    return this.width >= 46 * this.rem;
  }

  close(id: string): void {
    this.closeTabs([id]);
  }

  closeOthers(id: string): void {
    this.closeTabs(this.view.tabs.filter((tab) => tab.id !== id).map((tab) => tab.id));
  }

  /** Closes every tab without unsaved or pending changes. */
  closeSaved(): void {
    for (const tab of this.view.tabs.filter((tab) => !tabDirty(tab) && !tabBusy(tab))) this.view.close(tab.id);
  }

  /** Files shows as the right column (wide screens only). */
  get filesOpen(): boolean {
    return this.wide && devicePreferences.view.filesPanelOpen;
  }

  /** The floating thread summary is open or collapsed to its pill: one choice on this device. */
  toggleSummary(): void {
    devicePreferences.setView({ threadPanelCollapsed: !devicePreferences.view.threadPanelCollapsed });
  }

  /** Files is the right column on wide screens (one choice on this device) and a sheet on narrow ones. */
  toggleFiles(sheet: () => void): void {
    if (this.wide) devicePreferences.setView({ filesPanelOpen: !devicePreferences.view.filesPanelOpen });
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
