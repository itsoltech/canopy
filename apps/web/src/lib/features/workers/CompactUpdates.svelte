<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import UpdateActionButton from "./UpdateActionButton.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import type { DesktopUpdatesState } from "#lib/features/desktop/desktop-updates.svelte.ts";
  import UpdateRows from "./UpdateRows.svelte";
  import { cliActions } from "./cli-tools.svelte.ts";
  import type { UpdatesState } from "./updates.svelte.ts";
  import { updatesHeadline } from "./updates-headline.ts";
  import { isRateLimitMessage } from "@canopy/domain/release/http";
  import { bulkUpdatesAvailable } from "@canopy/domain/release/update-plan";
  import { whatsNew } from "#lib/features/updates/whats-new.svelte.ts";

  /**
   * The sidebar Updates popover (docs/updates.md): one summary line, rows that keep their height, one labelled
   * primary action. ⟳ means only Check now.
   */
  let {
    updates,
    app,
    class: className,
    onnotes,
  }: { updates: UpdatesState; app: DesktopUpdatesState; class?: ClassValue; onnotes?: () => void } = $props();

  const cli = cliActions();
  const snapshot = $derived(updates.snapshot);

  const checking = $derived(
    snapshot?.checking || updates.pending === "check" || cli.pending["check/"] || app.status?.phase === "checking",
  );

  const headline = $derived(updatesHeadline(updates, app, !!checking));
  const error = $derived(updates.error || snapshot?.checkError || cli.errors["check/"] || "");

  const stopped = $derived(
    snapshot?.run && ["failed", "blocked"].includes(snapshot.run.state) ? snapshot.run : undefined,
  );

  // This app's download waits for a restart and no Update all covers it (a remote or server gateway).
  const restart = $derived(
    (!!app.status?.stagedVersion || app.status?.phase === "downloaded") &&
      !(snapshot && bulkUpdatesAvailable(snapshot)) &&
      !stopped,
  );

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
  <header class="relative flex shrink-0 items-center gap-2 border-b border-divider px-3 py-2">
    <div class="min-w-0 flex-1">
      <h2 class="text-sm font-semibold">Updates</h2>
      <p
        class={[
          "h-5 truncate text-xs/5 tabular-nums",
          headline.tone === "rose"
            ? "text-rose-600 dark:text-rose-400"
            : headline.tone === "ink"
              ? "text-ink"
              : "text-muted",
        ]}
        role="status"
        title={headline.text}
      >
        {#key headline.text}<span class="t-swap">{headline.text}</span>{/key}
      </p>
    </div>
    <!-- Check never conflicts with a run, so it stays available; it only waits for itself. -->
    <IconButton size="sm" icon="arrow-path" label="Check now" loading={!!checking} onclick={() => void check()} />
    <!-- The divider is the run's bar: no extra line, no space reserved for it. -->
    <div
      class={[
        "pointer-events-none absolute -bottom-px left-0 h-0.5 bg-brand-600 transition-[width,opacity] duration-(--duration-slow) ease-(--ease-smooth-out) motion-reduce:transition-none dark:bg-brand-400",
        headline.progress === undefined && "opacity-0",
      ]}
      style:width={`${headline.progress ?? 0}%`}
      aria-hidden="true"
    ></div>
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
    <!-- Computers and workers first; agent CLIs collapse below (docs/updates.md). -->
    <UpdateRows {updates} {app} />
    {#if !snapshot}<p class="py-2 text-xs/5 text-muted" role="status">Loading update status…</p>{/if}
  </div>
  <footer class="flex h-11 shrink-0 items-center gap-4 border-t border-divider pr-2 pl-3 text-xs/5 text-muted">
    <a href="/settings/workers" class="rounded focus-ring hover:text-ink">Settings</a>
    {#if whatsNew.notice}<button
        type="button"
        class="t-rise rounded focus-ring hover:text-ink"
        onclick={() => {
          onnotes?.();
          whatsNew.show();
        }}>What's new</button
      >{/if}
    <!-- The primary action sits on the right, away from the links, so it appears without moving them. -->
    <span class="ml-auto flex">
      {#if stopped && !updates.active}
        <UpdateActionButton
          {updates}
          variant="primary"
          request={{ action: "retry_failed", desktopRequestId: stopped.id }}
          class="t-rise"
        />
      {:else if restart}
        <Button
          size="sm"
          variant="primary"
          class="t-rise"
          disabled={updates.active || !!app.status?.changingChannel}
          loading={app.restarting}
          onclick={() => void app.run()}>Restart to update</Button
        >
      {:else}<UpdateActionButton {updates} variant="primary" class="t-rise" />{/if}
    </span>
  </footer>
</section>
