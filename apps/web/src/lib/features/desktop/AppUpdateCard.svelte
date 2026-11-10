<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import ProgressBar from "#lib/shared/ui/ProgressBar.svelte";
  import UpdateReleaseNotes from "./UpdateReleaseNotes.svelte";
  import type { DesktopUpdatesState } from "./desktop-updates.svelte.ts";

  let { updates, class: className }: { updates: DesktopUpdatesState; class?: ClassValue } = $props();
  const status = $derived(updates.status);

  const busy = $derived(
    updates.pending || status?.changingChannel || status?.phase === "checking" || status?.phase === "downloading",
  );
</script>

<section class={["grid gap-4", className]} aria-label="This Canopy app">
  {#if status}
    <div class="grid gap-1">
      <h3 class="text-base font-medium sm:text-sm">This Canopy app</h3>
      <p class="text-base/6 text-zinc-500 tabular-nums select-text sm:text-sm/6 dark:text-zinc-400">
        {status.version} · {status.channel}{status.updateVersion ? ` → ${status.updateVersion}` : ""}
      </p>
      <p class="text-base/6 text-pretty text-zinc-600 select-text sm:text-sm/6 dark:text-zinc-300" role="status">
        {status.message}
      </p>
    </div>
    {#if status.phase === "downloading"}
      <ProgressBar label="App update download" value={status.progress ?? 0} />
      <p class="text-base/6 tabular-nums sm:text-sm/6">{Math.round(status.progress ?? 0)}% downloaded</p>
    {/if}
    {#if status.publishing && status.message !== status.publishing}<p
        class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400"
      >
        {status.publishing}
      </p>{/if}
    {#if status.phase === "downloaded"}<p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        Restarting stops the agents running on this computer.
      </p>{/if}
    <div class="flex flex-wrap items-center gap-3">
      <Button
        size="sm"
        variant={status.phase === "downloaded" ? "primary" : "secondary"}
        disabled={busy || status.phase === "disabled"}
        onclick={() => void updates.run()}
        >{status.phase === "downloaded" ? "Restart to update" : "Check for updates"}</Button
      >
      <a
        href="/settings/app-updates"
        class="text-base/6 text-zinc-500 underline focus-ring sm:text-sm/6 dark:text-zinc-400">App update settings</a
      >
    </div>
    {#if status.updateVersion && ["downloading", "downloaded", "error"].includes(status.phase)}
      <UpdateReleaseNotes
        releases={status.releases ?? []}
        channel={status.channel}
        class="border-t border-zinc-950/5 pt-4 dark:border-white/10"
      />
    {/if}
  {/if}
  {#if updates.error}<Alert tone="error">{updates.error}</Alert>{/if}
</section>
