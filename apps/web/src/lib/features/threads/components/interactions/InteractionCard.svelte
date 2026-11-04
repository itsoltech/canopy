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
      busy = false;
    }
    // On success the card disappears when the interaction update arrives.
  }
</script>

<section
  class={[
    "rounded-xl bg-white p-4 shadow-lg ring-1 dark:bg-zinc-950 dark:shadow-none",
    interaction.routedTo === "parent"
      ? "ring-violet-500/40 dark:ring-violet-400/30"
      : "ring-amber-500/40 dark:ring-amber-400/30",
  ]}
  aria-labelledby="{id}-title"
>
  <div class="flex items-start gap-2">
    <span class="flex h-lh items-center text-base/6"
      ><Icon
        name={interaction.kind === InteractionKind.PERMISSION ? "hand-raised" : "question-mark-circle"}
        class="fill-amber-500 dark:fill-amber-400"
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

  <div class="mt-3">
    {#if interaction.kind === InteractionKind.PERMISSION}
      <PermissionRequest toolName={interaction.toolName} requestJson={interaction.requestJson} {related} />
      <div class="mt-4 flex flex-wrap gap-2">
        <Button variant="primary" icon="check" loading={busy} onclick={() => respond({ allow: true })}>Allow</Button>
        <Button disabled={busy} onclick={() => respond({ allow: true, allowForSession: true })}
          >Allow for this session</Button
        >
        <Button
          variant="danger"
          disabled={busy}
          onclick={() => respond({ allow: false, message: "Denied by the user" })}>Deny</Button
        >
      </div>
    {:else if interaction.kind === InteractionKind.QUESTION}
      <p class="text-sm/6 text-zinc-500 dark:text-zinc-400">Answer in the question panel above the composer.</p>
    {:else}
      <ElicitationForm requestJson={interaction.requestJson} {busy} submit={respond} />
    {/if}
  </div>

  {#if error}<Alert tone="error" class="mt-3">{error}</Alert>{/if}
</section>
