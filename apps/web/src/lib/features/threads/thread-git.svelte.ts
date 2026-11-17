import { untrack } from "svelte";
import type { ui } from "@canopy/contracts";
import { threadGitStatus, pullThreadOrigin } from "./git-status.ts";
import { queries } from "#lib/shared/queries.svelte.ts";
import { toast } from "#lib/shared/ui/toast.svelte.ts";

/** Read only while the details are visible; opening, HEAD changes and turn transitions refresh it. */
export function useThreadGit(thread: () => ui.Thread, available: () => boolean) {
  let active = $state(false);
  let reading = $state(false);
  let manual = $state(false);
  let pulling = $state(false);
  let result = $state<{ threadId: string; value: ui.ThreadGitStatusResponse }>();
  let failure = $state<{ threadId: string; message: string }>();
  let failureAction = $state<"read" | "pull">("read");
  let pending: AbortController | undefined;
  let mutation = 0;
  let queued = false;

  // The shared query keeps a bounded per-thread snapshot across details remounts.
  const data = $derived(
    result?.threadId === thread().id
      ? result.value
      : queries.snapshot<ui.ThreadGitStatusResponse>(`GetThreadGitStatus:${thread().id}`).data,
  );

  const refreshKey = $derived.by(() => {
    const current = thread();

    return [
      current.id,
      current.status,
      current.worktree?.branch,
      current.worktree?.detachedCommit,
      current.checkoutHead?.branch,
      current.checkoutHead?.detachedCommit,
    ].join("\0");
  });

  async function reload(background = false) {
    if (!available() || pulling) return;

    if (reading) {
      queued = true;

      if (!background) manual = true;

      return;
    }

    const threadId = thread().id;
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    reading = true;
    manual = !background;
    failure = undefined;
    failureAction = "read";

    try {
      const value = await threadGitStatus(threadId, controller.signal);

      if (!controller.signal.aborted) result = { threadId, value };
    } catch {
      if (!controller.signal.aborted)
        failure = { threadId, message: "Could not read local changes. Refresh to retry." };
    } finally {
      if (pending === controller) reading = false;

      if (queued) {
        queued = false;

        if (active && available() && !pulling) void reload(true);
      }
    }
  }

  $effect(() => {
    void refreshKey;

    const timer = active && available() ? setTimeout(() => untrack(() => void reload(true)), 150) : undefined;

    return () => {
      clearTimeout(timer);
      pending?.abort();
    };
  });

  async function pull() {
    if (pulling || reading || !available()) return;
    const threadId = thread().id;
    const version = ++mutation;
    pending?.abort();
    pulling = true;
    failure = undefined;
    failureAction = "pull";

    try {
      const value = await pullThreadOrigin(threadId);

      if (version !== mutation) return;
      result = { threadId, value };
      toast("Pulled from origin");
    } catch (cause) {
      if (version === mutation)
        failure = {
          threadId,
          message: cause instanceof Error ? cause.message : "Could not pull from origin. Refresh and try again.",
        };
    } finally {
      if (version === mutation) pulling = false;
    }
  }

  return {
    get active() {
      return active;
    },
    set active(value: boolean) {
      active = value;
    },
    get loading() {
      return reading;
    },
    get refreshing() {
      return reading && (manual || !data);
    },
    get pulling() {
      return pulling;
    },
    get data() {
      return data;
    },
    get failureAction() {
      return failureAction;
    },
    get error() {
      return failure?.threadId === thread().id ? failure.message : "";
    },
    reload,
    pull,
  };
}
