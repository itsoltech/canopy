import { getContext, setContext } from "svelte";

/**
 * Project highlighted in the navigation. The project page knows it from the URL; the thread page
 * learns it from the thread snapshot and sets it here.
 */
export class ActiveProject {
  fromThread = $state<string | undefined>(undefined);
}

const KEY = Symbol("active-project");
export const provideActiveProject = (state: ActiveProject) => setContext(KEY, state);
export const useActiveProject = () => getContext<ActiveProject>(KEY);
