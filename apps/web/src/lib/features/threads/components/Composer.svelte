<script lang="ts">
  import { InteractionKind, type ui } from "@canopy/contracts";
  import { tick, type Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import type { ComposerActivity } from "./composer-compaction.ts";
  import ComposerTop from "./ComposerTop.svelte";
  import MessageComposer from "./MessageComposer.svelte";
  import QuestionForm from "./interactions/QuestionForm.svelte";
  import { QuestionSession } from "./interactions/question-session.svelte.ts";

  let {
    thread,
    worker,
    running,
    disabled = false,
    note,
    onsent,
    ongoal,
    top,
    questions = [],
    compact = false,
    panelsLabel,
    onexpand,
    onfocuschange,
    class: className,
  }: {
    thread: ui.Thread;
    worker: ui.Worker | undefined;
    running: boolean;
    disabled?: boolean;
    note?: string | undefined;
    onsent?: ((response: ui.SendMessageResponse) => void) | undefined;
    ongoal?: (() => void) | undefined;
    top?: Snippet | undefined;
    questions?: ui.Interaction[];
    class?: ClassValue;
    compact?: boolean;
    panelsLabel?: string;
    onexpand?: (activity?: ComposerActivity) => void;
    onfocuschange?: (focused: boolean) => void;
  } = $props();

  const pending = $derived(questions.filter((q) => q.kind === InteractionKind.QUESTION && q.status === "pending"));
  const active = $derived(pending.find((q) => !q.asynchronous) ?? pending[0]);

  // A synchronous set can preempt an asynchronous draft; switching back restores that draft.
  const sessions = new Map<string, QuestionSession>();

  const session = $derived.by(() => {
    if (!active) return undefined;
    let value = sessions.get(active.requestId);

    if (!value) {
      value = new QuestionSession(active);
      sessions.set(active.requestId, value);
    }

    return value;
  });

  $effect(() => {
    const ids = new Set(pending.map((q) => q.requestId));

    for (const id of sessions.keys()) if (!ids.has(id)) sessions.delete(id);
  });

  const answering = $derived(session && !session.done && !session.messaging);
  const approval = $derived(questions.find((q) => q.kind === InteractionKind.PERMISSION && q.status === "pending"));
  let steeringRequest = $state<string>();
  const steering = $derived(Boolean(approval && steeringRequest === approval.requestId));

  // Blocking questions stay expanded; asynchronous answers follow composer compaction.
  const folded = $derived(compact && active?.asynchronous !== false);
  let root = $state<HTMLDivElement>();
</script>

<div
  bind:this={root}
  class={["grid min-w-0 grid-cols-1", className]}
  data-composer
  data-pending-decision={Boolean(answering || approval) || undefined}
  data-compact={folded || undefined}
  onfocusin={() => {
    onfocuschange?.(true);
    onexpand?.();
  }}
  onfocusout={() => {
    void tick().then(() => onfocuschange?.(Boolean(root?.contains(document.activeElement))));
  }}
>
  {#if top || (session && !session.done)}
    <div class={["px-2 pt-px sm:px-3", !answering && "-mb-4"]}>
      <ComposerTop decision={Boolean(answering)}>
        {#if !answering}{@render top?.()}{/if}
        {#if session && !session.done}<QuestionForm
            {session}
            {disabled}
            {note}
            more={pending.length - 1}
            compact={folded}
          />{/if}
      </ComposerTop>
    </div>
  {/if}
  <!-- Keep the message draft mounted while answering. It returns intact when switching modes. -->
  {#if approval && !answering}
    <div
      class="relative flex items-center justify-between gap-2 rounded-2xl bg-surface p-2 text-sm/5 text-zinc-500 dark:text-zinc-400"
    >
      <p>Approval needed</p>
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={steering}
        onclick={() => (steeringRequest = steering ? undefined : approval.requestId)}
        >{steering ? "Hide steer editor" : "Steer instead…"}</Button
      >
    </div>
  {/if}
  <div
    class={["relative min-w-0", (answering || (approval && !steering)) && "hidden"]}
    inert={Boolean(answering || (approval && !steering))}
  >
    <MessageComposer
      {thread}
      {worker}
      {running}
      {disabled}
      {note}
      {onsent}
      {ongoal}
      compact={folded || Boolean(approval)}
      {panelsLabel}
      {onexpand}
    />
  </div>
</div>
