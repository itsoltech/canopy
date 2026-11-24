<script lang="ts">
  import type { Snippet } from "svelte";
  import Button from "./Button.svelte";
  import { provideDensity } from "./density.ts";
  import Icon from "./Icon.svelte";
  import IconButton from "./IconButton.svelte";
  import { dismiss, toasts } from "./toast.svelte.ts";

  /**
   * A polite live region in the bottom-right, clear of the desktop's drag strips. Only the cards take
   * pointer events. A toast rises in (`t-toast`) and leaves a little faster; actions sit below its text.
   */
  provideDensity("overlay");

  let { children, inDialog = false }: { children?: Snippet; inDialog?: boolean } = $props();
</script>

<div
  class={[
    "density-overlay pointer-events-none right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] left-[max(1rem,env(safe-area-inset-left))] z-50 sm:left-auto sm:w-96",
    inDialog ? "absolute" : "fixed",
  ]}
>
  <div
    class="grid"
    data-dialog-toasts={inDialog || undefined}
    class:window-toasts={!inDialog}
    role="status"
    aria-live="polite"
  >
    {#each toasts as entry (entry.id)}
      <div
        class="t-toast pointer-events-auto col-start-1 row-start-1 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-xl bg-white p-3 text-base/6 text-zinc-950 shadow-lg ring-1 ring-zinc-950/10 data-closing:pointer-events-none sm:text-sm/5 dark:bg-zinc-900 dark:text-zinc-100 dark:shadow-none dark:ring-white/10"
        data-closing={entry.closing || undefined}
      >
        <div class="size-5 self-start py-1 [&>svg]:size-5">
          <Icon
            name={entry.tone === "success"
              ? "check-circle"
              : entry.tone === "error"
                ? "exclamation-circle"
                : "information-circle"}
            tone="inherit"
            class={entry.tone === "success"
              ? "text-emerald-600 dark:text-emerald-400"
              : entry.tone === "error"
                ? "text-rose-600 dark:text-rose-400"
                : "text-sky-600 dark:text-sky-400"}
          />
        </div>
        <p class="min-w-0 py-1 wrap-anywhere" class:font-medium={Boolean(entry.description)}>{entry.text}</p>
        <div class="self-start">
          <IconButton icon="x-mark" label="Dismiss notification" onclick={() => dismiss(entry.id)} />
        </div>
        {#if entry.description}
          <p class="col-span-2 col-start-2 min-w-0 wrap-anywhere text-zinc-600 dark:text-zinc-400">
            {entry.description}
          </p>
        {/if}
        {#if entry.action}
          {@const action = entry.action}
          <div class="col-span-2 col-start-2 flex justify-end">
            <Button
              variant="primary"
              onclick={() => {
                dismiss(entry.id);
                action.run();
              }}
            >
              {action.label}
            </Button>
          </div>
        {/if}
      </div>
    {/each}
  </div>
  {@render children?.()}
</div>

<style>
  /* The main document is inert behind a native modal. Keep one copy of these messages visible. */
  :global(body:has(dialog:modal [data-dialog-toasts])) .window-toasts {
    display: none;
  }
</style>
