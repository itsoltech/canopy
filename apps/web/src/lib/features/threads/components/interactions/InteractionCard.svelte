<script lang="ts">
  import { InteractionKind, type Item, type ui } from "@canopy/contracts";
  import { humanizeToolName } from "#lib/shared/humanize.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { answerInteraction } from "../../api.ts";
  import ElicitationForm from "./ElicitationForm.svelte";
  import PermissionRequest from "./PermissionRequest.svelte";
  import ThreadLink from "../items/ThreadLink.svelte";
  import DecisionContent from "./DecisionContent.svelte";

  /**
   * The agent is blocked on a person: a permission (allow / deny), questions or an MCP form.
   * `related` is the timeline item the request is about (e.g. the file change to approve).
   */
  let {
    interaction,
    related,
    parent,
  }: { interaction: ui.Interaction; related: Item | undefined; parent?: ui.Thread | undefined } = $props();

  let busy = $state(false);
  let error = $state<string | undefined>(undefined);
  const id = $props.id();
  let expired = $state(false);

  const title = $derived.by(() => {
    if (interaction.kind === InteractionKind.QUESTION) return "The agent has a question";

    if (interaction.kind === InteractionKind.ELICITATION) return "The agent needs some details";

    if (interaction.toolName === "shell") return "Run this command?";

    if (interaction.toolName === "apply_patch") return "Apply this change?";

    if (interaction.toolName === "permissions") return "Grant extra permissions?";

    return `Allow ${humanizeToolName(interaction.toolName)}?`;
  });

  async function respond(answer: Parameters<typeof answerInteraction>[1]) {
    busy = true;
    error = undefined;

    try {
      await answerInteraction(interaction.requestId, answer);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);

      if (error.includes("This request expired.")) {
        expired = true;
        error = "This request expired. No answer was sent.";
      }

      busy = false;
    }
    // On success the card disappears when the interaction update arrives.
  }
</script>

<section
  class={[
    "rounded-xl bg-white shadow-lg ring-1 dark:bg-zinc-950 dark:shadow-none",
    interaction.kind === InteractionKind.PERMISSION
      ? "flex max-h-[min(65dvh,calc(100dvh-14rem))] min-h-0 flex-col"
      : "p-4",
    interaction.routedTo === "parent"
      ? "ring-violet-500/40 dark:ring-violet-400/30"
      : "ring-amber-500/40 dark:ring-amber-400/30",
  ]}
  aria-labelledby="{id}-title"
>
  <div class={["flex shrink-0 items-start gap-2", interaction.kind === InteractionKind.PERMISSION && "p-3"]}>
    <span class="flex h-lh items-center text-base/6"
      ><Icon
        name={interaction.kind === InteractionKind.PERMISSION ? "hand-raised" : "question-mark-circle"}
        class="text-amber-500 dark:text-amber-400"
      /></span
    >
    <div class="min-w-0 flex-1">
      <h2 id="{id}-title" class="text-base/6 font-semibold text-zinc-950 dark:text-white">{title}</h2>
      {#if interaction.routedTo === "parent"}
        <p class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm/5 text-violet-700 dark:text-violet-400">
          <Icon name="sparkles" tone="inherit" class="size-3.5" />
          {#if parent}<span>The agent of</span><ThreadLink threadId={parent.id} fallback={parent.title} /><span
              >answers this. You can step in.</span
            >{:else}The main agent answers this. You can step in.{/if}
        </p>
      {/if}
    </div>
  </div>

  {#if interaction.kind === InteractionKind.PERMISSION}
    <DecisionContent label="Permission request details">
      <div class="px-3 pb-3">
        <PermissionRequest toolName={interaction.toolName} requestJson={interaction.requestJson} {related} />
      </div>
      {#snippet actions()}
        {#if expired || interaction.status === "expired"}
          <p
            role="status"
            class="flex min-h-28 items-center p-3 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400"
          >
            Expired. The agent no longer needs an answer.
          </p>
        {:else}
          <div class="grid grid-cols-2 gap-2 p-3">
            <Button variant="primary" icon="check" loading={busy} onclick={() => respond({ allow: true })}>Allow</Button
            >
            <Button
              variant="danger"
              disabled={busy}
              onclick={() => respond({ allow: false, message: "Denied by the user" })}>Deny</Button
            >
            <div class="col-span-2 grid">
              <Button disabled={busy} onclick={() => respond({ allow: true, allowForSession: true })}
                >Allow for this session</Button
              >
            </div>
          </div>
        {/if}
        {#if error}<Alert tone={expired ? "info" : "error"} class="mx-3 mb-3">{error}</Alert>{/if}
      {/snippet}
    </DecisionContent>
  {:else}
    <div class="mt-3">
      {#if expired || interaction.status === "expired"}
        <p role="status" class="min-h-16 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
          Expired. The agent no longer needs an answer.
        </p>
      {:else if interaction.kind === InteractionKind.QUESTION}
        <p class="text-sm/6 text-zinc-500 dark:text-zinc-400">Answer in the question panel above the composer.</p>
      {:else}
        <ElicitationForm requestJson={interaction.requestJson} {busy} submit={respond} />
      {/if}
    </div>

    {#if error}<Alert tone={expired ? "info" : "error"} class="mt-3">{error}</Alert>{/if}
  {/if}
</section>
