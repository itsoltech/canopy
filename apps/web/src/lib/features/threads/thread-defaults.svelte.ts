/**
 * Defaults for new threads in this browser (Settings → Threads): workspace, Codex profile, model and
 * permissions. The new-thread composer starts from them; each thread can still change them.
 * Browser-local because the UI contract has no user settings yet.
 */
export interface ThreadDefaultValues {
  workspaceId: string;
  profileId: string;
  model: string;
  permissionMode: string;
}

const KEY = "oa-thread-defaults";
const EMPTY: ThreadDefaultValues = { workspaceId: "", profileId: "", model: "", permissionMode: "ASK" };

class ThreadDefaults {
  values = $state<ThreadDefaultValues>({ ...EMPTY });

  constructor() {
    if (typeof window === "undefined") return;
    try {
      this.values = { ...EMPTY, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<ThreadDefaultValues>) };
    } catch {
      // unreadable: defaults
    }
  }

  update(change: Partial<ThreadDefaultValues>): void {
    this.values = { ...this.values, ...change };
    localStorage.setItem(KEY, JSON.stringify(this.values));
  }

  reset(): void {
    this.values = { ...EMPTY };
    localStorage.removeItem(KEY);
  }
}

export const threadDefaults = new ThreadDefaults();
