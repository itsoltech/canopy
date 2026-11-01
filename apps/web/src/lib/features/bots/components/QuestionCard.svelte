<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { timeLabel } from "../chat-timeline.ts";
  import type { QuestionView } from "../model.ts";

  /**
   * A bot asks you to choose: options lettered A, B, C…; a click, Enter or the option's letter (while
   * the card has focus) answers. Once answered the choice stays marked and the card is read-only.
   * Without `onanswer` (a watched chat) it only shows the question.
   */
  let {
    question,
    onanswer,
    answering,
    class: className,
  }: { question: QuestionView; onanswer?: ((optionId: string) => void) | undefined; answering?: string | undefined; class?: ClassValue } = $props();

  const id = $props.id();
  const letters = "ABCDEFGHIJ";
  const answered = $derived(Boolean(question.answer));
  const open = $derived(!answered && !answering && Boolean(onanswer));

  function onkeydown(event: KeyboardEvent) {
    if (!open || event.altKey || event.ctrlKey || event.metaKey || event.key.length !== 1) return;
    const option = question.options[letters.indexOf(event.key.toUpperCase())];
    if (!option) return;
    event.preventDefault();
    onanswer?.(option.id);
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section aria-labelledby="{id}-prompt" class={["w-full max-w-sm rounded-2xl bg-white p-1 ring-1 ring-zinc-950/10 dark:bg-white/5 dark:ring-white/10", className]} {onkeydown}>
  <div class="flex items-start gap-2 px-3 pt-2.5 pb-2 text-base/6 sm:text-sm/6">
    <Icon name="question-mark-circle" class="h-lh fill-amber-500 dark:fill-amber-400" />
    <h3 id="{id}-prompt" class="font-medium text-pretty text-zinc-950 dark:text-white">{question.prompt}</h3>
  </div>
  <ul role="list" class="grid gap-0.5">
    {#each question.options as option, index (option.id)}
      {@const chosen = question.answer?.optionId === option.id || answering === option.id}
      <li>
        <button
          type="button"
          disabled={!open}
          aria-pressed={chosen}
          aria-keyshortcuts={letters[index]}
          class={[
            "flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left text-base/6 focus-ring not-disabled:hover:bg-zinc-950/4 aria-pressed:bg-brand-500/10 sm:py-2 sm:text-sm/6 dark:not-disabled:hover:bg-white/5",
            !open && !chosen && "opacity-50",
          ]}
          onclick={() => onanswer?.(option.id)}
        >
          <span class="flex h-lh items-center">
            <span
              class={[
                "grid size-6 shrink-0 place-items-center rounded-md font-mono text-xs/none font-medium ring-1 sm:size-5",
                chosen ? "bg-brand-600 text-white ring-brand-600" : "text-zinc-600 ring-zinc-950/15 dark:text-zinc-300 dark:ring-white/15",
              ]}
            >
              {letters[index]}
            </span>
          </span>
          <span class="min-w-0 flex-1">
            <span class="text-zinc-950 dark:text-white">{option.label}</span>
            {#if option.description}<span class="block text-zinc-500 dark:text-zinc-400">{option.description}</span>{/if}
          </span>
          {#if answering === option.id}
            <span class="flex h-lh items-center"><Spinner class="size-3.5" /></span>
          {:else if chosen}
            <Icon name="check" class="h-lh fill-brand-600 dark:fill-brand-400" label="Your answer" />
          {/if}
        </button>
      </li>
    {/each}
  </ul>
  <p class="px-3 pt-1 pb-2 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
    {#if question.answer}
      Answered {timeLabel(question.answer.at)}
    {:else if answering}
      Sending your answer…
    {:else if onanswer}
      Choose an option or press its letter.
    {:else}
      Waiting for an answer.
    {/if}
  </p>
</section>
