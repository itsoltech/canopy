import { getContext, setContext } from "svelte";
import { createSubscriber } from "svelte/reactivity";
import { WorkspaceStore, type Workspace } from "@canopy/domain/workspace";
import { WorkspaceFileConflict } from "@canopy/domain/workspace-file";
import { HttpError } from "#lib/shared/http.ts";
import { readFile, writeFile, deleteFile } from "#lib/features/files/api.ts";
import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { pauseThreadWarming } from "#lib/features/threads/warming.ts";

export const workspaceStore = new WorkspaceStore(
  {
    watchFiles: async (request, signal, receive) =>
      (await import("./watch-api.ts")).watchFiles(request, signal, receive),
    listDirectory: async (request, signal) => (await import("./directory-api.ts")).listDirectory(request, signal),
    read: (target, path, hash, signal) => {
      pauseThreadWarming();

      return readFile(target.threadId, path, target.itemId, hash, signal);
    },
    write: (target, path, text, hash, root) => fileMutation(() => writeFile(target.threadId, path, text, hash, root)),
    remove: (target, path, hash, root) => fileMutation(() => deleteFile(target.threadId, path, hash, root)),
  },
  16 * 1024 * 1024,
);

async function fileMutation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof HttpError && cause.status === 412) throw new WorkspaceFileConflict(cause.message);
    throw cause;
  }
}

const subscribe = createSubscriber((update) => workspaceStore.subscribe(update));

export function workspaceVersion(): number {
  subscribe();

  return workspaceStore.getVersion();
}

/** No storage-event listener: another window may seed a new session, never steal focus. */
export function connectWorkspace(scope: string): () => void {
  const key = `canopy.workspace.v1.${encodeURIComponent(scope)}`;

  try {
    workspaceStore.connect(localStorage.getItem(key), (raw) => {
      try {
        localStorage.setItem(key, raw);
      } catch {
        toast("Tab state could not be saved. Allow browser storage to keep it.", { tone: "error" });
      }
    });
  } catch {
    workspaceStore.connect(null, () => {});
  }

  const unload = (event: BeforeUnloadEvent) => {
    if (!workspaceStore.documents().some((document) => document.dirty || document.busy)) return;
    event.preventDefault();
    event.returnValue = "";
  };

  window.addEventListener("beforeunload", unload);

  return () => {
    window.removeEventListener("beforeunload", unload);
    workspaceStore.clear();
  };
}

const KEY = Symbol("workspace");
export const provideWorkspace = (view: () => Workspace) => setContext(KEY, view);
export const useWorkspace = () => getContext<(() => Workspace) | undefined>(KEY);
