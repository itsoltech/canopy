<script lang="ts">
  import { untrack } from "svelte";
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import {
    mutationRequest,
    sendMutation,
    mutationUnconfirmed,
    uncertainMutation,
  } from "@canopy/domain/github-mutations";
  import ChoiceControl from "#lib/shared/ui/ChoiceControl.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { mutations } from "./api.ts";
  import { mutationRefused } from "./mutation-errors.ts";

  let {
    file,
    snapshot,
    stale,
    onstate,
    onsettled,
    class: className,
  }: {
    file: github.PullRequestFile;
    snapshot: github.PullRequestSnapshot;
    stale: boolean;
    onstate: (path: string, state: string) => void;
    onsettled: () => Promise<void>;
    class?: ClassValue;
  } = $props();

  let optimistic = $state<boolean>();

  let busy = $state(false),
    error = $state("");

  let uncertain = $state(false),
    online = $state(true);

  const checked = $derived(optimistic ?? file.viewerViewedState === "VIEWED");
  const label = "Viewed";

  $effect(() => {
    void file;
    untrack(() => {
      optimistic = undefined;
      uncertain = false;
      error = "";
    });
  });

  $effect(() => {
    const update = () => (online = navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);

    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  });

  async function toggle(value: boolean) {
    if (busy || !online || stale || snapshot.stale) return;
    optimistic = value;
    busy = true;
    error = "";
    uncertain = false;
    onstate(file.path, value ? "VIEWED" : "UNVIEWED");

    const r = await sendMutation(
      mutations,
      mutationRequest(snapshot, crypto.randomUUID(), "viewed", { path: file.path, viewed: value }),
      mutationRefused,
    );

    if (r.state !== "succeeded") {
      optimistic = undefined;
      onstate(file.path, file.viewerViewedState);
      uncertain = mutationUnconfirmed(r);
      error = uncertain ? uncertainMutation : r.detail;
    } else {
      await onsettled();
      optimistic = undefined;
    }

    busy = false;
  }
</script>

<div class={["contents text-xs/4", className]}>
  <label
    class="col-start-2 row-start-1 flex min-h-11 cursor-pointer items-center justify-end gap-2 sm:min-h-10"
    title={label}
  >
    <span class="flex w-4 items-center justify-center">
      {#if busy}<Icon name="arrow-path" label="Saving…" />
      {:else if file.viewerViewedState === "DISMISSED"}<span {@attach tooltip("Changed since you viewed this file")}>
          <Icon name="clock" label="Changed since you viewed this file" class="text-amber-700 dark:text-amber-400" />
        </span>{/if}
    </span>
    <span {@attach tooltip(`${label} · ${file.path}`)}
      ><ChoiceControl
        name="viewed"
        aria-label={`${label} · ${file.path}`}
        {checked}
        disabled={busy || !online || stale || snapshot.stale || !file.viewerViewedState || uncertain}
        onchange={(e) => void toggle(e.currentTarget.checked)}
      /></span
    >
  </label>
  {#if error}<p role="status" class="col-span-full pb-2 text-right text-rose-700 dark:text-rose-400">
      {error}
      {#if uncertain}<a
          class="underline"
          href={`https://github.com/${snapshot.summary?.ref?.repositoryName}/pull/${snapshot.summary?.ref?.number}/files`}
          target="_blank"
          rel="noreferrer">Open on GitHub</a
        >{/if}
    </p>{/if}
</div>
