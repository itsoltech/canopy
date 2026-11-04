/**
 * "Fork from here" and "Fork thread" (docs/threads.md, "Fork od tury"): a new main thread with the history up to
 * and including an ended turn, in the same place and with the same settings; it opens once created, a failure
 * is a toast.
 */
import { SvelteSet } from "svelte/reactivity";
import { goto } from "$app/navigation";
import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { forkThread } from "./api.ts";

export { forkable, lastForkPoint } from "./fork-point.ts";

/** Turns being forked right now (their buttons show progress; a second click does nothing). */
export const forking = new SvelteSet<string>();

export async function forkFrom(threadId: string, turnId: string): Promise<void> {
  if (forking.has(turnId)) return;
  forking.add(turnId);

  try {
    const fork = await forkThread(threadId, turnId);

    if (fork) await goto(`/threads/${encodeURIComponent(fork.id)}`);
  } catch (error) {
    toast(error instanceof Error ? `Could not fork: ${error.message}` : "Could not fork the thread", { tone: "error" });
  } finally {
    forking.delete(turnId);
  }
}
