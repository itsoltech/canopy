import { getContext, setContext } from "svelte";
import type { ui } from "@canopy/contracts";

/** Whether the Add project dialog is open; the palette command and Settings → Projects open the same flow. */
export class AddProjectState {
  open = $state(false);
  /** After adding: go to the project's settings (Settings → Projects) or stay and confirm with a toast. */
  openProject = $state(false);
  project = $state<ui.Project>();
  workerId = $state<string>();
  findGit = $state(false);

  show({
    openProject = false,
    project,
    workerId,
    findGit = false,
  }: { openProject?: boolean; project?: ui.Project; workerId?: string; findGit?: boolean } = {}): void {
    this.openProject = openProject;
    this.project = project;
    this.workerId = workerId;
    this.findGit = findGit && !project;
    this.open = true;
  }
}

const KEY = Symbol("add-project");
export const provideAddProject = (state: AddProjectState) => setContext(KEY, state);
export const useAddProject = (): AddProjectState | undefined => getContext<AddProjectState | undefined>(KEY);
