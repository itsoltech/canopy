<script lang="ts">
  import Button from "./Button.svelte";
  import { provideDensity } from "./density.ts";
  import Icon from "./Icon.svelte";
  import IconButton from "./IconButton.svelte";
  import { dismiss, toasts } from "./toast.svelte.ts";

  /**
   * A polite live region in the bottom-right, clear of the desktop's drag strips. Only the cards take
   * pointer events. A toast rises in (`t-toast`) and leaves a little faster; actions stay beside its text.
   */
  provideDensity("overlay");
</script>

<div
  class="density-overlay pointer-events-none fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] left-[max(1rem,env(safe-area-inset-left))] z-50 grid sm:left-auto sm:w-96"
  role="status"
  aria-live="polite"
>
  {#each toasts as entry (entry.id)}
    <div
      class="t-toast pointer-events-auto col-start-1 row-start-1 flex items-start gap-3 rounded-xl bg-white p-1.5 text-base/6 text-zinc-950 shadow-lg ring-1 ring-zinc-950/10 data-closing:pointer-events-none sm:text-sm/5 dark:bg-zinc-800 dark:text-zinc-100 dark:shadow-none dark:ring-white/10"
      data-closing={entry.closing || undefined}
    >
      <div class="flex h-8 shrink-0 items-center sm:h-7">
        {#if entry.tone === "success"}
          <span class="t-success-check text-emerald-600 dark:text-emerald-400" aria-hidden="true">
            <svg viewBox="0 0 16 16" fill="none" class="size-4"
              ><path
                d="M4 8.5l2.5 2.5L12 5"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              /></svg
            >
          </span>
        {:else}
          <Icon
            name={entry.tone === "error" ? "exclamation-circle" : "information-circle"}
            class={entry.tone === "error" ? "text-rose-600 dark:text-rose-400" : "text-sky-600 dark:text-sky-400"}
          />
        {/if}
      </div>
      <p class="min-w-0 flex-1 py-1 wrap-anywhere">{entry.text}</p>
      <div class="flex shrink-0 items-center gap-1">
        {#if entry.action}
          {@const action = entry.action}
          <Button
            variant="secondary"
            onclick={() => {
              dismiss(entry.id);
              action.run();
            }}
          >
            {action.label}
          </Button>
        {/if}
        <IconButton icon="x-mark" label="Dismiss notification" onclick={() => dismiss(entry.id)} />
      </div>
    </div>
  {/each}
</div>
