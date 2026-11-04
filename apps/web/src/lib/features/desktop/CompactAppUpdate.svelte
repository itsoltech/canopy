<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import UpdateItem from "#lib/features/workers/UpdateItem.svelte";
  import UpdateReleaseNotes from "./UpdateReleaseNotes.svelte";
  import type { DesktopUpdatesState } from "./desktop-updates.svelte.ts";

  let { updates, class: className }: { updates: DesktopUpdatesState; class?: ClassValue } = $props();
  const status = $derived(updates.status);

  const busy = $derived(
    updates.pending || !!status?.changingChannel || ["checking", "downloading"].includes(status?.phase ?? ""),
  );
</script>

{#if status}
  <UpdateItem
    name="This Canopy app"
    icon="computer-desktop"
    current={status.version}
    target={status.updateVersion}
    status={status.phase === "downloaded"
      ? "Ready"
      : status.phase === "downloading"
        ? `${Math.round(status.progress ?? 0)}%`
        : status.phase === "checking"
          ? "Checking"
          : status.phase === "error"
            ? "Failed"
            : status.phase === "disabled"
              ? "Disabled"
              : status.publishing
                ? "Publishing"
                : status.updateVersion
                  ? "Available"
                  : "Up to date"}
    tone={status.phase === "error" ? "rose" : status.phase === "downloaded" ? "emerald" : busy ? "amber" : "neutral"}
    detail={status.publishing || status.message}
    error={updates.error || (status.phase === "error" ? status.message : "")}
    {busy}
    progress={status.phase === "downloading" ? status.progress : undefined}
    class={className}
  >
    {#snippet action()}
      <IconButton
        icon={status.phase === "downloaded" ? "arrow-up" : "arrow-path"}
        size="sm"
        label={status.phase === "downloaded"
          ? "Restart to update Canopy. This stops agents running on this computer."
          : status.publishing || status.message || "Check for app updates"}
        disabled={busy || status.phase === "disabled"}
        loading={updates.pending}
        onclick={() => void updates.run()}
      />
    {/snippet}
    {#snippet children()}
      {#if status.updateVersion && status.releases?.some((release) => !!release.markdown.trim()) && ["downloading", "downloaded", "error"].includes(status.phase)}
        <Disclosure summaryClass="py-1 text-sm/5 text-muted">
          {#snippet summary()}What’s new{/snippet}
          <div class="break-anywhere max-h-60 overflow-y-auto overscroll-contain pt-2">
            <UpdateReleaseNotes releases={status.releases ?? []} channel={status.channel} />
          </div>
        </Disclosure>
      {/if}
    {/snippet}
  </UpdateItem>
{:else if updates.error}<p
    class={["break-anywhere text-sm/5 text-rose-600 dark:text-rose-400", className]}
    role="status"
  >
    {updates.error}
  </p>{/if}
