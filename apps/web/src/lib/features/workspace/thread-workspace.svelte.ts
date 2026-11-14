import { untrack } from "svelte";
import type { Attachment } from "svelte/attachments";
import { FILES_PANEL_WIDTH } from "@canopy/domain/device-view";
import { useShell } from "#lib/features/navigation/shell.ts";
import { sidebarTravel } from "#lib/features/navigation/sidebar-layout.svelte.ts";
import type { Workspace, WorkspaceTab } from "@canopy/domain/workspace";
import { fileTab, tabBusy, tabDirty } from "@canopy/domain/workspace-modules";
import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
import { provideWorkspace, workspaceStore, workspaceVersion } from "./workspace.svelte.ts";

export class ThreadWorkspace {
  /** Width of the thread area and Files together, where the sidebar is going (`measure`). */
  width = $state(0);
  rem = $state(16);
  /** Files width while its edge is dragged. */
  panelDraft = $state<number>();
  closing = $state<WorkspaceTab[]>([]);
  #closingView: Workspace | undefined;
  #closingIds: string[] = [];
  #frame: HTMLElement | undefined;
  readonly #shell = useShell();

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

  get panelMax(): number {
    return Math.min(FILES_PANEL_WIDTH.max, Math.max(FILES_PANEL_WIDTH.min, this.width - 30 * this.rem));
  }

  /** Width of the Files column when open, px. */
  get panelSize(): number {
    return Math.min(this.panelDraft ?? devicePreferences.view.filesPanelWidth, this.panelMax);
  }

  /**
   * How much wider the thread area will be once the sidebar and the Files column have eased open or shut (negative
   * while one opens), px; `areaRight` is the area's right edge, measured in the same callback. Layout decisions
   * (Files beside the thread, the docked summary) add it, so they are made once for the end state and never flip
   * while a column moves.
   */
  travel(areaRight: number): number {
    const sidebar = sidebarTravel(this.#shell.sidebar);

    if (!this.#frame || !this.wide) return sidebar;

    return sidebar + this.#frame.getBoundingClientRect().right - areaRight - (this.filesOpen ? this.panelSize : 0);
  }

  /** Measures the frame (thread area and Files) where the sidebar is going. */
  measure: Attachment<HTMLElement> = (node) => {
    this.#frame = node;
    const update = () => (this.width = node.clientWidth + sidebarTravel(this.#shell.sidebar));
    const observer = new ResizeObserver(update);
    observer.observe(node);
    update();

    return () => {
      observer.disconnect();
      this.#frame = undefined;
    };
  };

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
