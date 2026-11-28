<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { DesktopUpdatesState } from "#lib/features/desktop/desktop-updates.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { whatsNew } from "#lib/features/updates/whats-new.svelte.ts";
  import { bulkUpdatesAvailable } from "@canopy/domain/release/update-plan";
  import type { UpdatesState } from "./updates.svelte.ts";
  import { updatesHeadline } from "./updates-headline.ts";
  import UpdateActionButton from "./UpdateActionButton.svelte";
  import UpdateCheckButton from "./UpdateCheckButton.svelte";
  import UpdateProgress from "./UpdateProgress.svelte";
  import UpdateRows from "./UpdateRows.svelte";

  let {
    updates,
    app,
    class: className,
    onclose,
  }: { updates: UpdatesState; app: DesktopUpdatesState; class?: ClassValue; onclose?: () => void } = $props();

  const snapshot = $derived(updates.snapshot);

  const checking = $derived(
    !!(snapshot?.checking || updates.pending === "check" || app.pending || app.status?.phase === "checking"),
  );

  const headline = $derived(updatesHeadline(updates, app, checking));

  const stopped = $derived(
    snapshot?.run && ["failed", "blocked"].includes(snapshot.run.state) ? snapshot.run : undefined,
  );

  const restartInFooter = $derived(
    (!!app.status?.stagedVersion || app.status?.phase === "downloaded") &&
      !app.status?.manualInstall &&
      !stopped &&
      updates.run?.state !== "running" &&
      !(snapshot && bulkUpdatesAvailable(snapshot)),
  );
</script>

<section class={["flex max-h-[min(70dvh,32rem)] min-h-0 flex-col", className]} aria-label="App updates">
  <header class="relative flex shrink-0 items-center gap-2 border-b border-divider px-3 py-2">
    <div class="min-w-0 flex-1">
      <h2 class="text-sm/5 font-semibold">App updates</h2>
      <p
        class={[
          "truncate text-xs/5 tabular-nums",
          headline.tone === "rose" ? "text-rose-600 dark:text-rose-400" : headline.tone === "muted" && "text-muted",
        ]}
        role="status"
        title={headline.text}
      >
        {headline.text}
      </p>
    </div>
    <UpdateCheckButton {updates} {app} compact />
    {#if headline.progress !== undefined}<UpdateProgress
        label="Update all progress"
        value={headline.progress}
        class="absolute inset-x-0 -bottom-px"
      />{/if}
  </header>
  <div class="min-h-0 scroll-py-1 scroll-stable overflow-y-auto overscroll-contain px-3">
    <UpdateRows {updates} {app} compact {restartInFooter} />
  </div>
  <footer class="flex min-h-11 shrink-0 items-center gap-3 border-t border-divider px-3 py-1 text-xs/4 text-muted">
    <div class="flex min-w-0 flex-wrap items-center gap-x-3">
      <a
        class="rounded whitespace-nowrap focus-ring hover:text-ink"
        href="/settings/app-updates#topic-status"
        onclick={onclose}>View details</a
      >
      {#if whatsNew.notice}
        <button
          type="button"
          class="rounded whitespace-nowrap focus-ring hover:text-ink desktop:cursor-pointer"
          onclick={() => {
            onclose?.();
            whatsNew.show();
          }}>What's new</button
        >
      {/if}
    </div>
    <div class="ml-auto shrink-0">
      {#if stopped && updates.run?.state !== "running"}
        <UpdateActionButton
          {updates}
          variant="primary"
          request={{ action: "retry_failed", desktopRequestId: stopped.id }}
        />
      {:else if restartInFooter}
        <Button
          size="sm"
          variant="primary"
          disabled={!!app.status?.changingChannel || (updates.writable && updates.active)}
          loading={app.restarting}
          {@attach tooltip("Restarting stops the agents running on this computer.")}
          onclick={() => void app.run()}>Restart to update</Button
        >
      {:else}
        <UpdateActionButton {updates} variant="primary" />
      {/if}
    </div>
  </footer>
</section>
