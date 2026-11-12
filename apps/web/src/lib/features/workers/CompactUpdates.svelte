<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import type { DesktopUpdatesState } from "#lib/features/desktop/desktop-updates.svelte.ts";
  import UpdateProgress from "./UpdateProgress.svelte";
  import UpdateRows from "./UpdateRows.svelte";
  import StoppedUpdateActions from "./StoppedUpdateActions.svelte";
  import { updatesAvailable } from "./compact-updates.ts";
  import { cliActions } from "./cli-tools.svelte.ts";
  import type { UpdatesState } from "./updates.svelte.ts";
  import { updateIndicator } from "./update-indicator.ts";
  import { isRateLimitMessage } from "@canopy/domain/release/http";
  import { whatsNew } from "#lib/features/updates/whats-new.svelte.ts";

  let {
    updates,
    app,
    class: className,
    onnotes,
  }: { updates: UpdatesState; app: DesktopUpdatesState; class?: ClassValue; onnotes?: () => void } = $props();

  const cli = cliActions();
  const snapshot = $derived(updates.snapshot);
  const run = $derived(snapshot?.run);
  const busy = $derived(run?.state === "running" || !!updates.pending);

  const checking = $derived(
    snapshot?.checking || updates.pending === "check" || cli.pending["check/"] || app.status?.phase === "checking",
  );

  const summary = $derived(
    updateIndicator(app.status, snapshot, app.error || updates.error, updates.pending, app.remote),
  );

  const error = $derived(updates.error || snapshot?.checkError || cli.errors["check/"] || "");
  const completed = $derived(run?.steps.filter((step) => step.state === "succeeded").length ?? 0);

  async function check() {
    await Promise.all([
      snapshot?.admin || snapshot?.gatewayBundled ? updates.manage({ action: "check" }) : updates.reload(),
      cli.check(),
      app.status ? app.check() : Promise.resolve(),
    ]);
    await updates.reload();
  }
</script>

<section class={["flex max-h-[min(70dvh,32rem)] min-h-0 flex-col", className]} aria-label="Updates center">
  <header class="flex shrink-0 items-center gap-2 border-b border-divider px-3 py-2">
    <div class="min-w-0 flex-1">
      <h2 class="text-sm font-semibold">Updates</h2>
      <p class="truncate text-xs/5 text-muted tabular-nums" role="status" title={summary.message}>
        {summary.phase === "error"
          ? "Update failed"
          : summary.phase === "quiet"
            ? "Up to date"
            : summary.phase === "available"
              ? "Updates available"
              : summary.phase === "ready"
                ? "Restart to finish the update"
                : summary.message}
      </p>
    </div>
    <IconButton
      size="sm"
      icon="information-circle"
      label="Update all skips externally managed items. It updates the gateway, binary workers, native agent CLIs, then Canopy apps. Linked computers update last, one at a time."
    />
    <IconButton
      size="sm"
      icon="arrow-path"
      label="Check now"
      disabled={busy || checking}
      loading={checking}
      onclick={() => void check()}
    />
    {#if snapshot && updatesAvailable(snapshot)}<IconButton
        size="sm"
        icon="arrow-up"
        label={run && ["failed", "blocked"].includes(run.state) ? "Retry updates" : "Update all"}
        disabled={busy || !snapshot || (summary.phase === "quiet" && !run)}
        loading={run?.state === "running"}
        onclick={() => void updates.manage({ action: "update_all" })}
      />{/if}
  </header>
  <div class="min-h-0 scroll-py-1 scroll-stable overflow-y-auto overscroll-contain px-3 py-1">
    {#if error}<p
        class={[
          "break-anywhere py-2 text-xs/5",
          isRateLimitMessage(error) ? "text-muted" : "text-rose-600 dark:text-rose-400",
        ]}
        role="status"
      >
        {error}
      </p>{/if}
    {#if run && ["running", "failed", "blocked"].includes(run.state)}
      <div class="border-b border-divider py-2 text-xs/5">
        <p role="status">
          {run.state === "running" ? `Updating · ${completed}/${run.steps.length}` : "Updates stopped"}
        </p>
        {#if run.state === "running"}<UpdateProgress
            label="Update all progress"
            value={run.steps.length ? (completed / run.steps.length) * 100 : 0}
            class="mt-1"
          />{/if}
        {#if run.reason}<p class="break-anywhere line-clamp-2 text-rose-600 dark:text-rose-400" title={run.reason}>
            {run.reason}
          </p>{/if}
        <StoppedUpdateActions {run} {updates} class="mt-2" />
      </div>
    {/if}
    <!-- Computers and workers first; agent CLIs collapse below (docs/updates.md). -->
    <UpdateRows {updates} {app} />
    {#if !snapshot}<p class="py-2 text-xs/5 text-muted" role="status">Loading update status…</p>{/if}
  </div>
  <footer class="flex shrink-0 flex-wrap gap-x-4 gap-y-1 border-t border-divider px-3 py-2 text-xs/5 text-muted">
    <a href="/settings/workers" class="rounded focus-ring hover:text-ink">Update details</a>
    <button
      type="button"
      class="rounded focus-ring hover:text-ink"
      onclick={() => {
        onnotes?.();
        whatsNew.show();
      }}>What's new</button
    >
    <a href="/settings/app-updates" class="rounded focus-ring hover:text-ink">App updates</a>
  </footer>
</section>
