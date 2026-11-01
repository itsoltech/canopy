import type { ProviderKey } from "./providers.ts";

/**
 * Defaults for new threads in this browser (Settings → Threads): workspace, provider, profile, a model
 * per provider and permissions. The new-thread composer starts from them; each thread can still change
 * them. Browser-local because the UI contract has no user settings yet.
 */
export interface ThreadDefaultValues {
  workspaceId: string;
  provider: ProviderKey;
  profileId: string;
  models: Record<ProviderKey, string>;
  permissionMode: string;
}

const KEY = "oa-thread-defaults";
const empty = (): ThreadDefaultValues => ({ workspaceId: "", provider: "CODEX", profileId: "", models: { CLAUDE: "", CODEX: "" }, permissionMode: "ASK" });

/** Reads saved values; values saved before providers were selectable had one (Codex) `model`. */
function restore(saved: Partial<ThreadDefaultValues> & { model?: string }): ThreadDefaultValues {
  const base = empty();
  return {
    workspaceId: saved.workspaceId ?? base.workspaceId,
    provider: saved.provider === "CLAUDE" ? "CLAUDE" : "CODEX",
    profileId: saved.profileId ?? base.profileId,
    models: { CLAUDE: saved.models?.CLAUDE ?? "", CODEX: saved.models?.CODEX ?? saved.model ?? "" },
    permissionMode: saved.permissionMode ?? base.permissionMode,
  };
}

class ThreadDefaults {
  values = $state<ThreadDefaultValues>(empty());

  constructor() {
    if (typeof window === "undefined") return;
    try {
      this.values = restore(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<ThreadDefaultValues>);
    } catch {
      // unreadable: defaults
    }
  }

  update(change: Partial<ThreadDefaultValues>): void {
    this.values = { ...this.values, ...change };
    localStorage.setItem(KEY, JSON.stringify(this.values));
  }

  reset(): void {
    this.values = empty();
    localStorage.removeItem(KEY);
  }
}

export const threadDefaults = new ThreadDefaults();
