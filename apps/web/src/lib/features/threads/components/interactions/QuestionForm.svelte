<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { tick, untrack } from "svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import QuestionOption from "./QuestionOption.svelte";
  import type { QuestionSession } from "./question-session.svelte.ts";

  let { session, more = 0, class: className }: { session: QuestionSession; more?: number; class?: ClassValue } = $props();
  const question = $derived(session.question);
  const id = $props.id();
  let panel = $state<HTMLElement>();
  $effect(() => {
    session.step;
    untrack(() => {
      if (panel?.contains(document.activeElement)) {
        void tick().then(() => panel?.querySelector<HTMLElement>('input, legend')?.focus());
      }
    });
  });

  function keyboard(event: KeyboardEvent) {
    if (session.collapsed || session.messaging || session.busy || event.isComposing || event.altKey || event.metaKey || event.ctrlKey || !panel?.contains(event.target as Node)) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, textarea, [contenteditable="true"], input[type="text"], input[type="password"]')) return;
    const inputs = [...panel.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')];
    const index = inputs.indexOf(target as HTMLInputElement);
    const number = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1;
    if (number >= 0 && question.options[number]) {
      event.preventDefault(); session.select(question.options[number]!.label); inputs[number]?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); inputs[(index + (event.key === "ArrowDown" ? 1 : inputs.length - 1)) % inputs.length]?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault(); void session.submit();
    }
  }
</script>

<svelte:window onkeydown={keyboard} />

<section bind:this={panel} class={["min-w-0 px-3 py-2.5 sm:px-4", className]} aria-label="Questions from the agent">
  <div class="flex min-w-0 items-center gap-2">
    <button type="button" class="relative flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left text-sm/5 focus-ring" aria-expanded={!session.collapsed} aria-controls="{id}-body" onclick={() => (session.collapsed = !session.collapsed)}>
      <Icon name="question-mark-circle" class="fill-amber-600 dark:fill-amber-400" />
      <span class="truncate rounded-md bg-zinc-950/5 px-2 py-0.5 font-medium text-zinc-950 dark:bg-white/8 dark:text-white">{question.header || "Question"}</span>
      <span class="shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400" aria-live="polite">{session.step + 1} of {session.questions.length}</span>
      {#if more}<span class="text-zinc-500 dark:text-zinc-400">+{more} pending</span>{/if}
      <Icon name="chevron-down" class={["t-acc-chevron ml-auto", !session.collapsed && "rotate-180"]} />
      <TouchTarget />
    </button>
  </div>
  <div id="{id}-body" class="t-acc-panel" data-open={!session.collapsed || undefined} inert={session.collapsed}>
    <div>
      <div class="grid gap-2 pt-2">
        {#if session.interaction.routedTo === "parent"}<p class="text-sm/5 text-violet-700 dark:text-violet-400">The parent agent can answer. You can step in.</p>{/if}
        <p class="text-sm/5 text-zinc-500 dark:text-zinc-400" role="status">
          {session.interaction.asynchronous ? "The agent keeps working — answer any time." : "The agent is waiting for your answers."}
        </p>
        <fieldset disabled={session.busy} class="min-w-0">
          <legend tabindex="-1" class="w-full wrap-anywhere text-pretty text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">{question.question}</legend>
          {#if question.options.length}
            <ol role="list" class="grid max-h-[min(32dvh,22rem)] gap-0.5 overflow-y-auto overscroll-contain pt-2">
              {#each question.options as option, index (index)}
                <li><QuestionOption {option} {index} multiple={question.kind === "multiple_choice"} name="{id}-{question.id}" checked={session.labels.includes(option.label)} recommended={question.recommended === option.label} disabled={session.busy} onselect={() => session.select(option.label)} /></li>
              {/each}
            </ol>
          {/if}
        </fieldset>
        <div class="flex flex-wrap items-center justify-between gap-1 pt-1 text-sm/5">
          <div class="flex items-center gap-1">
            <Button size="sm" variant="ghost" disabled={session.busy || session.step === 0} onclick={() => session.step--}>Back</Button>
            <Button size="sm" variant="ghost" disabled={session.busy} onclick={() => void session.submit(true)}>Skip</Button>
            <Button size="sm" variant="ghost" disabled={session.busy} onclick={() => void session.finish(true)}>Skip all</Button>
            {#if !session.interaction.asynchronous}<Button size="sm" variant="ghost" disabled={session.busy} onclick={() => void session.finish(false, true)}>Dismiss</Button>{/if}
          </div>
          {#if session.interaction.asynchronous}
            <Button size="sm" variant="ghost" aria-pressed={session.messaging} disabled={session.busy} onclick={() => (session.messaging = !session.messaging)}>{session.messaging ? "Answer questions" : "Send a message"}</Button>
          {/if}
        </div>
        {#if session.error}<Alert tone="error">{session.error}</Alert>{/if}
      </div>
    </div>
  </div>
</section>
