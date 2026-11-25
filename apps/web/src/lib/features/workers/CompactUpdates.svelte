<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { DesktopUpdatesState } from "#lib/features/desktop/desktop-updates.svelte.ts";
  import { whatsNew } from "#lib/features/updates/whats-new.svelte.ts";
  import type { UpdatesState } from "./updates.svelte.ts";
  import { updatesHeadline } from "./updates-headline.ts";
  import UpdateProgress from "./UpdateProgress.svelte";

  let {
    updates,
    app,
    class: className,
    onclose,
  }: { updates: UpdatesState; app: DesktopUpdatesState; class?: ClassValue; onclose?: () => void } = $props();

  const checking = $derived(
    !!(updates.snapshot?.checking || updates.pending === "check" || app.status?.phase === "checking"),
  );

  const headline = $derived(updatesHeadline(updates, app, checking));
</script>

<section aria-label="App updates" class={className}>
  <a
    href="/settings/app-updates#topic-status"
    onclick={onclose}
    class="flex min-w-0 items-center gap-3 rounded-lg px-3 py-2 focus-ring hover:bg-zinc-950/3 dark:hover:bg-white/5"
  >
    <div class="min-w-0 flex-1">
      <h2 class="text-sm/5 font-semibold">App updates</h2>
      <p
        class={[
          "break-anywhere text-xs/5 tabular-nums",
          headline.tone === "rose" ? "text-rose-600 dark:text-rose-400" : "text-muted",
        ]}
        role="status"
      >
        {headline.text}
      </p>
    </div>
    <Icon name="chevron-right" class="shrink-0 text-muted" />
  </a>
  {#if headline.progress !== undefined}<UpdateProgress label="Update all progress" value={headline.progress} />{/if}
  {#if whatsNew.notice}
    <div class="border-t border-divider px-3 py-2">
      <button
        type="button"
        class="t-rise rounded text-xs/5 text-muted focus-ring hover:text-ink desktop:cursor-pointer"
        onclick={() => {
          onclose?.();
          whatsNew.show();
        }}>What's new</button
      >
    </div>
  {/if}
</section>
