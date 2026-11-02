<script lang="ts">
  import { InteractionKind, type ui } from "@open-agents/contracts";
  import { tick, type Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import ComposerBox from "./ComposerBox.svelte";
  import ComposerTop from "./ComposerTop.svelte";
  import MessageComposer from "./MessageComposer.svelte";
  import QuestionForm from "./interactions/QuestionForm.svelte";
  import { QuestionSession } from "./interactions/question-session.svelte.ts";

  let { thread, worker, running, disabled = false, note, onsent, leading, top, questions = [], compact = false, panelsLabel, onexpand, onfocuschange, class: className }: {
    thread: ui.Thread; worker: ui.Worker | undefined; running: boolean; disabled?: boolean;
    note?: string | undefined; onsent?: ((response: ui.SendMessageResponse) => void) | undefined;
    leading?: Snippet | undefined; top?: Snippet | undefined; questions?: ui.Interaction[]; class?: ClassValue;
    compact?: boolean; panelsLabel?: string; onexpand?: () => void; onfocuschange?: (focused: boolean) => void;
  } = $props();
  const pending = $derived(questions.filter((q) => q.kind === InteractionKind.QUESTION && q.status === "pending"));
  const active = $derived(pending.find((q) => !q.asynchronous) ?? pending[0]);
  // A synchronous set can preempt an asynchronous draft; switching back restores that draft.
  const sessions = new Map<string, QuestionSession>();
  const session = $derived.by(() => {
    if (!active) return undefined;
    let value = sessions.get(active.requestId);
    if (!value) { value = new QuestionSession(active); sessions.set(active.requestId, value); }
    return value;
  });
  $effect(() => {
    const ids = new Set(pending.map((q) => q.requestId));
    for (const id of sessions.keys()) if (!ids.has(id)) sessions.delete(id);
  });
  const answering = $derived(session && !session.done && !session.messaging);
  // Questions remain obvious, including an async question the user has started answering.
  const folded = $derived(compact && !active);
  let root = $state<HTMLDivElement>();
</script>

<div bind:this={root} class={["grid min-w-0 grid-cols-1", className]} data-composer data-compact={folded || undefined}
  onfocusin={() => { onfocuschange?.(true); onexpand?.(); }}
  onfocusout={() => { void tick().then(() => onfocuschange?.(Boolean(root?.contains(document.activeElement)))); }}
>
  {#if top || (session && !session.done)}
    <div class="t-composer-fold" data-open={!folded || undefined} inert={folded}>
    <div><div class="px-2 sm:px-3">
      <ComposerTop>
        {@render top?.()}
        {#if session && !session.done}<QuestionForm {session} more={pending.length - 1} />{/if}
      </ComposerTop>
    </div></div></div>
  {/if}
  <!-- Keep the message draft mounted while answering. It returns intact when switching modes. -->
  <div class={["relative min-w-0", answering && "hidden"]} inert={Boolean(answering)}>
    <MessageComposer {thread} {worker} {running} {disabled} {note} {onsent} {leading} compact={folded} {panelsLabel} {onexpand} />
  </div>
  {#if answering && session}
    <form class="relative" onsubmit={(event) => { event.preventDefault(); void session.submit(); }}>
      <ComposerBox
        bind:value={() => session.text, (value) => { session.text = value; }}
        label={`Your answer: ${session.question.header || session.question.question}`}
        placeholder="Type your own answer, or leave this blank to use the selected option"
        disabled={disabled || session.busy}
        sending={session.busy}
        canSend={Boolean(session.answer)}
        allowEmpty={Boolean(session.labels.length)}
        sendLabel="Submit"
        secret={session.question.secret}
      >
        {#snippet controls()}<p class="flex-1 text-sm/5 text-zinc-500 dark:text-zinc-400">{session.step + 1 < session.questions.length ? "Submit to continue" : "Submit answers"}</p>{/snippet}
      </ComposerBox>
    </form>
  {/if}
</div>
