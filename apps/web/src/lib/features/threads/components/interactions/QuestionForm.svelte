<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { tick, untrack } from "svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import QuestionOption from "./QuestionOption.svelte";
  import type { QuestionSession } from "./question-session.svelte.ts";
  import ComposerPanelHeader from "../ComposerPanelHeader.svelte";
  import ComposerPanelBody from "../ComposerPanelBody.svelte";

  let {
    session,
    more = 0,
    compact = false,
    class: className,
  }: { session: QuestionSession; more?: number; compact?: boolean; class?: ClassValue } = $props();

  const expanded = $derived(!session.collapsed && !compact);
  const question = $derived(session.question);
  const id = $props.id();
  let panel = $state<HTMLElement>();

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

<section bind:this={panel} class={["min-w-0", className]} aria-label="Questions from the agent">
  <ComposerPanelHeader {expanded} controls="{id}-body" onclick={(wasExpanded) => (session.collapsed = wasExpanded)}>
    <Icon name="question-mark-circle" size="sm" class="fill-amber-600 dark:fill-amber-400" />
    <span class="truncate font-medium text-zinc-950 dark:text-white">{question.header || "Question"}</span>
    <span class="shrink-0 text-zinc-500 tabular-nums dark:text-zinc-400" aria-live="polite"
      >{session.step + 1} of {session.questions.length}</span
    >
    {#if more}<span class="text-zinc-500 dark:text-zinc-400">+{more} pending</span>{/if}
  </ComposerPanelHeader>
  <ComposerPanelBody id="{id}-body" open={expanded}>
    <div class="grid gap-1.5 px-4 pt-1 pb-2">
      {#if session.interaction.routedTo === "parent"}<p
          class="text-[0.8125rem]/5 text-violet-700 sm:text-xs/5 dark:text-violet-400"
        >
          The parent agent can answer. You can step in.
        </p>{/if}
      <p class="text-[0.8125rem]/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400" role="status">
        {session.interaction.asynchronous
          ? "The agent keeps working — answer any time."
          : "The agent is waiting for your answers."}
      </p>
      <fieldset disabled={session.busy} class="min-w-0">
        <legend
          tabindex="-1"
          class="w-full text-sm/5 font-medium text-pretty wrap-anywhere text-zinc-950 sm:text-[0.8125rem]/5 dark:text-white"
          >{question.question}</legend
        >
        {#if question.options.length}
          <ol role="list" class="grid max-h-[min(32dvh,22rem)] gap-0.5 overflow-y-auto overscroll-contain pt-1">
            {#each question.options as option, index (index)}
              <li>
                <QuestionOption
                  {option}
                  {index}
                  multiple={question.kind === "multiple_choice"}
                  name="{id}-{question.id}"
                  checked={session.labels.includes(option.label)}
                  recommended={question.recommended === option.label}
                  disabled={session.busy}
                  onselect={() => session.select(option.label)}
                />
              </li>
            {/each}
          </ol>
        {/if}
      </fieldset>
      <div class="flex flex-wrap items-center justify-between gap-1 text-sm/5">
        <div class="flex items-center gap-1">
          <Button size="sm" variant="ghost" disabled={session.busy || session.step === 0} onclick={() => session.step--}
            >Back</Button
          >
          <Button size="sm" variant="ghost" disabled={session.busy} onclick={() => void session.submit(true)}
            >Skip</Button
          >
          <Button size="sm" variant="ghost" disabled={session.busy} onclick={() => void session.finish(true)}
            >Skip all</Button
          >
          {#if !session.interaction.asynchronous}<Button
              size="sm"
              variant="ghost"
              disabled={session.busy}
              onclick={() => void session.finish(false, true)}>Dismiss</Button
            >{/if}
        </div>
        {#if session.interaction.asynchronous}
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={session.messaging}
            disabled={session.busy}
            onclick={() => (session.messaging = !session.messaging)}
            >{session.messaging ? "Answer questions" : "Send a message"}</Button
          >
        {/if}
      </div>
      {#if session.error}<Alert tone="error">{session.error}</Alert>{/if}
    </div>
  </ComposerPanelBody>
</section>
