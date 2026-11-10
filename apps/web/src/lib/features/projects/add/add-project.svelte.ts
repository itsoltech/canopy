import { getContext, setContext } from "svelte";
import type { ui } from "@canopy/contracts";

/** Whether the Add project dialog is open; the palette command and Settings → Projects open the same flow. */
export class AddProjectState {
  open = $state(false);
  /** After adding: go to the project's settings (Settings → Projects) or stay and confirm with a toast. */
  openProject = $state(false);
  project = $state<ui.Project>();

  show({ openProject = false, project }: { openProject?: boolean; project?: ui.Project } = {}): void {
    this.openProject = openProject;
    this.project = project;
    this.open = true;
  }
}

const KEY = Symbol("add-project");
export const provideAddProject = (state: AddProjectState) => setContext(KEY, state);
export const useAddProject = (): AddProjectState | undefined => getContext<AddProjectState | undefined>(KEY);
