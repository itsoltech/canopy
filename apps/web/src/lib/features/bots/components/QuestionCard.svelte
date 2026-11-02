<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { timeLabel } from "../chat-timeline.ts";
  import type { QuestionView } from "../model.ts";
  import ChatCard from "./ChatCard.svelte";

  /**
   * A bot asks you something: options lettered A, B, C… (a click, Enter or the option's letter while the
   * card has focus answers), your own words when `freeText`, or Skip. Once answered the choice or your
   * words stay and the card is read-only. Without `onanswer` (a watched chat) it only shows the question.
   * `onanswer` gets an option id, `text:…` for your words, or `discard` for Skip.
   */
  let {
    question,
    onanswer,
    answering,
    class: className,
  }: { question: QuestionView; onanswer?: ((optionId: string) => void) | undefined; answering?: string | undefined; class?: ClassValue } = $props();

  const id = $props.id();
  let text = $state("");
  const letters = "ABCDEFGHIJ";
  const answered = $derived(Boolean(question.answer));
  const open = $derived(!answered && !answering && Boolean(onanswer));

  function onkeydown(event: KeyboardEvent) {
    if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable=true]")) return;
    if (!open || event.altKey || event.ctrlKey || event.metaKey || event.key.length !== 1) return;
    const option = question.options[letters.indexOf(event.key.toUpperCase())];
    if (!option) return;
    event.preventDefault();
    onanswer?.(option.id);
  }
</script>

<ChatCard labelledby="{id}-prompt" class={["p-1", className]} {onkeydown}>
  {#if question.routineTitle}<p class="px-3 pt-2 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">From routine “{question.routineTitle}”</p>{/if}
  <div class="flex items-start gap-2 px-3 pt-2.5 pb-2 text-base/6 sm:text-sm/6">
    <Icon name="question-mark-circle" class="h-lh shrink-0 fill-sky-500 dark:fill-sky-400" />
    <h3 id="{id}-prompt" class="font-medium text-pretty text-zinc-950 dark:text-white">{question.prompt}</h3>
  </div>
  {#if question.options.length > 0}
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
              "flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left text-base/6 focus-ring not-disabled:hover:bg-zinc-950/4 aria-pressed:bg-zinc-950/5 sm:py-2 sm:text-sm/6 dark:not-disabled:hover:bg-white/5 dark:aria-pressed:bg-white/8",
              !open && !chosen && "opacity-50",
            ]}
            onclick={() => onanswer?.(option.id)}
          >
            <span class="flex h-lh items-center">
              <span
                class={[
                  "grid size-6 shrink-0 place-items-center rounded-md font-mono text-xs/none font-medium ring-1 sm:size-5",
                  chosen ? "bg-zinc-900 text-white ring-zinc-900 dark:bg-white dark:text-zinc-950 dark:ring-white" : "text-zinc-600 ring-zinc-950/15 dark:text-zinc-300 dark:ring-white/15",
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
              <Icon name="check" class="h-lh shrink-0" label="Your answer" />
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if question.answer && !question.answer.optionId && !question.answer.skipped && question.answer.text}
    <p class="mx-3 mb-1 rounded-xl bg-zinc-950/4 px-3 py-2 text-base/6 whitespace-pre-wrap text-zinc-800 sm:text-sm/6 dark:bg-white/5 dark:text-zinc-200"><span class="sr-only">Your answer: </span>{question.answer.text}</p>
  {/if}
  {#if question.freeText && open}
    <form class="flex items-end gap-2 px-2 pt-1 pb-1" onsubmit={(event) => { event.preventDefault(); if (text.trim() && open) onanswer?.(`text:${text.trim()}`); }}>
      <label class="sr-only" for="{id}-answer">Your answer</label>
      <div class="min-w-0 flex-1">
        <Input id="{id}-answer" name="answer" bind:value={text} maxlength={32000} autocomplete="off" placeholder={question.options.length > 0 ? "Or answer in your own words" : "Your answer"} />
      </div>
      <Button type="submit" size="sm" variant="primary" disabled={!text.trim()}>Send</Button>
    </form>
  {/if}
  <div class="flex items-center justify-between gap-3 px-3 pt-1 pb-2">
    <p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      {#if question.answer?.skipped}
        Skipped
      {:else if question.answer}
        Answered {timeLabel(question.answer.at)}
      {:else if answering}
        Sending your answer…
      {:else if onanswer}
        {question.options.length > 0 ? "Choose an option or press its letter." : "The bot is waiting for your answer."}
      {:else}
        Waiting for an answer.
      {/if}
    </p>
    {#if open}<Button size="sm" variant="ghost" onclick={() => onanswer?.("discard")}>Skip</Button>{/if}
  </div>
</ChatCard>
