import { untrack } from "svelte";
import type { AgentPreviewTarget, AgentTool, ui } from "@canopy/contracts";
import type { PreviewSelection } from "#lib/features/preview/automatic-preview.svelte.ts";
import type { Attachment } from "svelte/attachments";
import { FILES_PANEL_WIDTH } from "@canopy/domain/device-view";
import { useShell } from "#lib/features/navigation/shell.ts";
import { sidebarTravel } from "#lib/features/navigation/sidebar-layout.svelte.ts";
import type { Workspace, WorkspaceTab } from "@canopy/domain/workspace";
import { fileTab, tabBusy, tabDirty } from "@canopy/domain/workspace-modules";
import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
import { provideWorkspace, workspaceStore, workspaceVersion } from "./workspace.svelte.ts";

class PreviewChoice {
  workerId = "";
  fit = $state<"fit" | "actual">("fit");
  target = $state<AgentPreviewTarget>();
  selection = $state<PreviewSelection>();
}

// Scoped to workspace lifetime: clearing the client scope also releases its private targets.
const previewChoices = new WeakMap<Workspace, PreviewChoice>();

export class ThreadWorkspace {
  /** Width of the thread area and Files together, where the sidebar is going (`measure`). */
  width = $state(0);
  rem = $state(16);
  /** Files width while its edge is dragged. */
  panelDraft = $state<number>();
  previewWidth = $state(520);
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
      untrack(() => {
        workspaceStore.touch(view);
        this.panelDraft = undefined;
      });

      return () => view.currentFile?.document.cancel();
    });
  }

  bindCheckout(thread: () => ui.Thread | undefined) {
    const workspace = $derived(this.view);
    $effect(() => {
      const current = thread();
      const view = workspace;

      if (current) untrack(() => view.store.bindCheckout(view, current));
    });
  }

  get view() {
    void workspaceVersion();

    return workspaceStore.view(this.threadId());
  }

  get panelOpen(): boolean {
    return this.view.panel.open;
  }
  set panelOpen(open: boolean) {
    this.view.panel.open = open;
    workspaceStore.notify(true);
  }
  get panelMode() {
    return this.view.panel.mode;
  }
  set panelMode(mode: "files" | "diff" | "preview") {
    this.view.panel.mode = mode;
    workspaceStore.notify(true);
  }
  get previewTool(): AgentTool {
    return this.view.panel.tool;
  }
  set previewTool(tool: AgentTool) {
    this.view.panel.tool = tool;
    workspaceStore.notify(true);
  }
  get previewChoice(): PreviewChoice {
    const view = this.view;
    let choice = previewChoices.get(view);

    if (!choice) {
      choice = new PreviewChoice();
      previewChoices.set(view, choice);
    }

    return choice;
  }

  get previewTabActive(): boolean {
    return this.current?.kind === "module" && this.current.module === "preview";
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
    return this.wide && this.panelOpen && !(this.panelMode === "preview" && this.previewTabActive);
  }

  get panelMax(): number {
    return Math.min(
      this.panelMode === "preview" ? 1100 : FILES_PANEL_WIDTH.max,
      Math.max(this.panelMin, this.width - (this.panelMode === "preview" ? 26 : 30) * this.rem),
    );
  }

  get panelMin(): number {
    return this.panelMode === "preview" ? 320 : FILES_PANEL_WIDTH.min;
  }
  get panelDefault(): number {
    return this.panelMode === "preview" ? 520 : FILES_PANEL_WIDTH.default;
  }

  /** Width of the selected side panel when open, px. */
  get panelSize(): number {
    return Math.min(
      this.panelDraft ?? (this.panelMode === "preview" ? this.previewWidth : devicePreferences.view.filesPanelWidth),
      this.panelMax,
    );
  }

  setPanelWidth(value: number): void {
    if (this.panelMode === "preview") this.previewWidth = value;
    else devicePreferences.setView({ filesPanelWidth: value });
    this.panelDraft = undefined;
  }

  showPanel(mode: "files" | "diff" | "preview"): void {
    if (mode === "preview" && this.previewTabActive) {
      this.view.select("thread");
      this.panelOpen = true;
      this.panelMode = mode;

      return;
    }

    const same = this.panelMode === mode;
    this.view.panel = { ...this.view.panel, mode, open: same ? !this.panelOpen : true };
    this.panelDraft = undefined;
    workspaceStore.notify(true);
  }

  openPreviewTab(): void {
    this.view.openModule({ module: "preview", resource: "" });

    if (this.previewTabActive) this.panelOpen = false;
  }

  openPreview(selection: PreviewSelection): void {
    if (this.previewTabActive) this.view.select("thread");
    this.previewChoice.selection = selection;
    this.previewChoice.target = selection.target;
    this.view.panel = { open: true, mode: "preview", tool: selection.tool };
    this.panelDraft = undefined;
    workspaceStore.notify(true);
  }

  /** The sidebar's `--sidebar-width`, for the chat column that follows it (layout.css `data-chat-placement`). */
  get sidebarWidth(): string | undefined {
    return this.#shell.sidebar?.cssWidth;
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
