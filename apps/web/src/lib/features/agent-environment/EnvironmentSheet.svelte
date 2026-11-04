<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { pageIn } from "#lib/shared/ui/motion.ts";

  let {
    open = $bindable(false),
    title,
    steps,
    step = $bindable(0),
    busy = false,
    error = "",
    nextDisabled = false,
    submitDisabled = false,
    submitLabel = "Add and sync",
    nextLabel = "Next",
    onnext,
    onsave,
    onback,
    children,
    class: className,
  }: {
    open?: boolean;
    title: string;
    steps: string[];
    step?: number;
    busy?: boolean;
    error?: string;
    nextDisabled?: boolean;
    submitDisabled?: boolean;
    submitLabel?: string;
    nextLabel?: string;
    onnext?: (step: number) => boolean | Promise<boolean>;
    onsave: () => void | Promise<void>;
    onback?: () => void;
    children: Snippet<[number]>;
    class?: ClassValue;
  } = $props();

  let body = $state<HTMLDivElement>();
  let direction = $state(1);
  let validation = $state("");

  $effect(() => {
    const current = step;
    validation = "";

    if (!open) return;

    void tick().then(() => {
      if (current !== step) return;
      body?.scrollIntoView({ block: "start", behavior: "instant" });

      const field = body?.querySelector<HTMLElement>(
        "input:not([type=file]):not([type=hidden]):not([disabled]), textarea:not([disabled]), button[role=combobox]:not([disabled]), [data-step-focus]",
      );

      (field ?? body)?.focus({ preventScroll: true });
    });
  });

  async function advance() {
    if (busy) return;

    if (step === steps.length - 1) {
      await onsave();

      return;
    }

    if (onnext && !(await onnext(step))) return;
    direction = 1;
    step++;
  }
</script>

<Dialog bind:open {title} size="output" fullscreen bare dismissible={!busy} class={className}>
  <form
    novalidate
    class="grid min-w-0 grid-rows-[auto_1fr_auto] max-sm:min-h-(--window-safe-height)"
    oninput={() => (validation = "")}
    onsubmit={(event) => {
      event.preventDefault();
      const invalid = event.currentTarget.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        "input:invalid, textarea:invalid",
      );
      if (invalid) {
        validation = invalid.validationMessage;
        invalid.focus();
        return;
      }
      validation = "";
      void advance();
    }}
  >
    <header class="sticky top-0 z-10 grid gap-3 border-b border-divider bg-surface p-5 sm:p-6">
      <div class="flex items-start justify-between gap-3">
        <div class="grid min-w-0 gap-1">
          <h2 class="text-lg font-semibold text-balance wrap-anywhere">{title}</h2>
          <p class="text-base text-muted tabular-nums sm:text-sm" aria-live="polite">
            Step {step + 1} of {steps.length} · {steps[step]}
          </p>
        </div>
        <IconButton icon="x-mark" label="Close editor" disabled={busy} onclick={() => (open = false)} />
      </div>
      <ol role="list" aria-label="Steps" class="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-base sm:text-sm">
        {#each steps as label, index (label)}
          <li
            aria-current={index === step ? "step" : undefined}
            class={index === step ? "font-medium text-ink" : "text-muted"}
          >
            {index + 1}. {label}
          </li>
        {/each}
      </ol>
    </header>
    <div bind:this={body} tabindex="-1" class="min-w-0 scroll-mt-40 p-5 outline-none sm:p-6">
      {#key step}
        <fieldset disabled={busy} class="grid min-w-0 gap-5" in:pageIn={{ from: direction }}>
          <legend class="sr-only">{steps[step]}</legend>
          {@render children(step)}
        </fieldset>
      {/key}
      {#if validation || error}<Alert class="mt-4" tone="error">{validation || error}</Alert>{/if}
    </div>
    <footer
      class="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-divider bg-surface p-5 pb-[max(--spacing(5),env(safe-area-inset-bottom))] sm:p-6"
    >
      <Button
        disabled={busy}
        onclick={() => {
          if (step === 0) open = false;
          else {
            direction = -1;
            onback?.();
            step--;
          }
        }}>{step === 0 ? "Cancel" : "Back"}</Button
      >
      <Button
        type="submit"
        variant="primary"
        loading={busy}
        disabled={step === steps.length - 1 ? submitDisabled : nextDisabled}
      >
        {step === steps.length - 1 ? submitLabel : nextLabel}
      </Button>
    </footer>
  </form>
</Dialog>
