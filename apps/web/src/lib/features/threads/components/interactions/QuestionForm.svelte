<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { tick, untrack } from "svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import QuestionOption from "./QuestionOption.svelte";
  import type { QuestionSession } from "./question-session.svelte.ts";
  import ComposerPanelHeader from "../ComposerPanelHeader.svelte";
  import DecisionContent from "./DecisionContent.svelte";

  let {
    session,
    more = 0,
    compact = false,
    disabled = false,
    note,
    class: className,
  }: {
    session: QuestionSession;
    more?: number;
    compact?: boolean;
    disabled?: boolean;
    note?: string;
    class?: ClassValue;
  } = $props();

  const expanded = $derived(!session.collapsed && !compact && !session.messaging);
  const question = $derived(session.question);
  const id = $props.id();
  let panel = $state<HTMLElement>();

  function answerKey(event: KeyboardEvent) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();

    if (!disabled && !session.busy) void session.submit();
  }

  $effect(() => {
    void session.step;
    untrack(() => {
      if (panel?.contains(document.activeElement)) {
        void tick().then(() => panel?.querySelector<HTMLElement>("input, legend")?.focus());
      }
    });
  });

  function keyboard(event: KeyboardEvent) {
    if (
      session.collapsed ||
      session.messaging ||
      session.busy ||
      disabled ||
      event.isComposing ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey ||
      !(event.target instanceof Element) ||
      !panel?.contains(event.target)
    )
      return;
    const target = event.target;

    if (target.closest('button, textarea, [contenteditable="true"], input[type="text"], input[type="password"]'))
      return;
    const inputs = [...panel.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')];
    const index = inputs.findIndex((input) => input === target);
    const number = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1;

    if (number >= 0 && question.options[number]) {
      event.preventDefault();
      session.select(question.options[number]!.label);
      inputs[number]?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      inputs[(index + (event.key === "ArrowDown" ? 1 : inputs.length - 1)) % inputs.length]?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      void session.submit();
    }
  }
</script>

<svelte:window onkeydown={keyboard} />

<section
  bind:this={panel}
  class={["flex max-h-[70dvh] min-w-0 flex-col", className]}
  aria-label="Questions from the agent"
>
  <ComposerPanelHeader
    {expanded}
    controls="{id}-body"
    onclick={(wasExpanded) => {
      session.collapsed = wasExpanded;
      session.messaging = false;
    }}
  >
    <Icon name="question-mark-circle" size="sm" class="text-amber-600 dark:text-amber-400" />
    <span class="truncate font-medium text-zinc-950 dark:text-white">{question.header || "Question"}</span>
    {#if question.options.length}<span class="shrink-0 text-zinc-500 dark:text-zinc-400"
        >{question.options.length} options</span
      >{/if}
    {#if session.questions.length > 1}<span
        class="shrink-0 text-zinc-500 tabular-nums dark:text-zinc-400"
        aria-live="polite">{session.step + 1} of {session.questions.length}</span
      >{/if}
    {#if more}<span class="text-zinc-500 dark:text-zinc-400">+{more} pending</span>{/if}
  </ComposerPanelHeader>
  {#if expanded}
    <div id="{id}-body" class="flex min-h-0 flex-col">
      <DecisionContent
        label="Question and answer"
        moreLabel={question.options.length ? "More options and answer below" : "More question details below"}
      >
        <div class="grid gap-1.5 px-4 pt-1 pb-2">
          {#if session.interaction.routedTo === "parent"}<p
              class="text-[0.8125rem]/5 text-violet-700 sm:text-xs/5 dark:text-violet-400"
            >
              The parent agent can answer. You can step in.
            </p>{/if}
          <p class="text-[0.8125rem]/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400" role="status">
            {session.interaction.asynchronous
              ? "The agent keeps working. Answer any time."
              : "The agent is waiting for your answers."}
          </p>
          <fieldset disabled={disabled || session.busy} class="min-w-0">
            <legend
              tabindex="-1"
              class="w-full text-sm/5 font-medium text-pretty wrap-anywhere text-zinc-950 sm:text-[0.8125rem]/5 dark:text-white"
              >{question.question}</legend
            >
            {#if question.options.length}
              <p class="pt-1 text-sm/5 text-zinc-500 dark:text-zinc-400">
                {question.options.length} options · {question.kind === "multiple_choice" ? "Choose any" : "Choose one"}
              </p>
              <ol role="list" class="grid gap-0.5 pt-1">
                {#each question.options as option, index (index)}
                  <li>
                    <QuestionOption
                      {option}
                      {index}
                      multiple={question.kind === "multiple_choice"}
                      name="{id}-{question.id}"
                      checked={session.labels.includes(option.label)}
                      recommended={question.recommended === option.label}
                      disabled={disabled || session.busy}
                      onselect={() => session.select(option.label)}
                    />
                  </li>
                {/each}
              </ol>
            {/if}
          </fieldset>
          <label for="{id}-answer" class="text-sm/5 font-medium text-zinc-950 dark:text-white"
            >{question.options.length ? "Or type your own answer" : "Your answer"}</label
          >
          {#if question.secret}
            <Input
              id="{id}-answer"
              type="password"
              autocomplete="off"
              onkeydown={answerKey}
              bind:value={() => session.text, (value) => (session.text = value)}
              disabled={disabled || session.busy}
            />
          {:else}
            <Textarea
              id="{id}-answer"
              rows={2}
              resize={false}
              onkeydown={answerKey}
              bind:value={() => session.text, (value) => (session.text = value)}
              disabled={disabled || session.busy}
              placeholder="Type your answer…"
            />
          {/if}
          {#if session.error}<Alert tone="error">{session.error}</Alert>{/if}
        </div>
        {#snippet actions()}
          <div class="grid gap-1 px-3 py-2">
            <div class="flex flex-wrap items-center justify-between gap-2">
              {#if session.step > 0}<Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled || session.busy}
                  onclick={() => session.step--}>Back</Button
                >{/if}
              <Button
                size="sm"
                variant="primary"
                loading={session.busy}
                disabled={disabled || !session.answer}
                onclick={() => void session.submit()}
                >{session.step + 1 < session.questions.length ? "Submit and continue" : "Submit answer"}</Button
              >
            </div>
            <div class="flex flex-wrap items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || session.busy}
                onclick={() => void session.submit(true)}>Skip question</Button
              >
              {#if session.questions.length > 1}<Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled || session.busy}
                  onclick={() => void session.finish(true)}>Skip all</Button
                >{/if}
              {#if !session.interaction.asynchronous}<Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled || session.busy}
                  onclick={() => void session.finish(false, true)}>Dismiss request</Button
                >{/if}
            </div>
            <p class="text-xs/4 text-zinc-500 dark:text-zinc-400">
              {#if session.questions.length > 1}Skip leaves this question unanswered. Skip all sends no answers.{:else}Skip
                sends no answer.{/if}
              {#if !session.interaction.asynchronous}
                Dismiss cancels the request.{/if}
            </p>
            {#if disabled && note}<p class="text-sm/5 text-zinc-500 dark:text-zinc-400">{note}</p>{/if}
            {#if session.interaction.asynchronous}
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={session.messaging}
                disabled={disabled || session.busy}
                onclick={() => (session.messaging = !session.messaging)}
                >{session.messaging ? "Answer questions" : "Send a message"}</Button
              >
            {/if}
          </div>
        {/snippet}
      </DecisionContent>
    </div>
  {/if}
</section>
