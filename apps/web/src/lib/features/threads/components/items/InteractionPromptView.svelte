<script lang="ts">
  import { InteractionKind, type InteractionPrompt, type ItemStatus } from "@canopy/contracts";
  import { parseObject } from "#lib/shared/format.ts";
  import { humanizeToolName } from "#lib/shared/humanize.ts";
  import { isEmptyNode, structureJson } from "#lib/shared/structure.ts";
  import StatusBadge from "#lib/shared/ui/StatusBadge.svelte";
  import PermissionRequest from "../interactions/PermissionRequest.svelte";
  import { answerText, parseQuestions } from "../interactions/questions.ts";
  import ItemFrame from "./ItemFrame.svelte";
  import ThreadLink from "./ThreadLink.svelte";
  import RawToggle from "./tools/RawToggle.svelte";
  import Section from "./tools/Section.svelte";
  import StructuredView from "./tools/StructuredView.svelte";

  /**
   * Record of a permission request or question on the timeline: what was asked (a command, a change, the
   * questions) and the answer, in words; who answered and the outcome. The request and response as sent
   * stay behind "Show raw".
   */
  let { prompt, status }: { prompt: InteractionPrompt; status: ItemStatus } = $props();
  const kind = $derived(prompt.kind === InteractionKind.PERMISSION ? "Permission" : prompt.kind === InteractionKind.QUESTION ? "Question" : "Form");
  // A question says itself in the body; a permission names what it is about.
  const subject = $derived(
    prompt.kind !== InteractionKind.PERMISSION
      ? ""
      : prompt.toolName === "shell" ? "Run a command" : prompt.toolName === "apply_patch" ? "Apply a change" : prompt.toolName === "permissions" ? "Extra permissions" : humanizeToolName(prompt.toolName),
  );
  const questions = $derived(prompt.kind === InteractionKind.QUESTION ? parseQuestions(prompt.requestJson) : []);
  // Answers to questions arrive keyed by question id (`{ id: { answers: [...] } }`), possibly under `answers`.
  const answers = $derived(Object.fromEntries(questions.map((q) => [q.id, answerText(prompt.responseJson, q)])));
  // A permission's answer is its outcome (the badge); only a message given with it adds something.
  const response = $derived(
    prompt.kind === InteractionKind.PERMISSION ? structureJson(JSON.stringify({ message: parseObject(prompt.responseJson)["message"] ?? null })) : structureJson(prompt.responseJson),
  );
  const answered = $derived(questions.some((q) => answers[q.id]));
</script>

<ItemFrame icon={prompt.kind === InteractionKind.PERMISSION ? "shield-check" : "question-mark-circle"} {status}>
  {#snippet title()}
    <span class="flex min-w-0 items-center gap-1.5">
      <span class="shrink-0">{kind}</span>
      {#if prompt.kind === InteractionKind.QUESTION && questions[0]}
        <span class="min-w-0 truncate text-zinc-600 dark:text-zinc-400">
          {questions[0].header || questions[0].question}
          {#if answers[questions[0].id]} → {questions[0].secret ? "Answered (hidden)" : answers[questions[0].id]}{:else if prompt.outcome === "cancelled"} → Dismissed{/if}
          {#if questions.length > 1} · +{questions.length - 1}{/if}
        </span>
      {/if}
      {#if subject}<span class="truncate text-zinc-800 dark:text-zinc-200">{subject}</span>{/if}
      {#if prompt.answeredByThreadId}
        <span class="text-zinc-500 dark:text-zinc-400">answered by</span><ThreadLink threadId={prompt.answeredByThreadId} fallback="Parent agent" />
      {:else if prompt.answeredByUserId}
        <span class="text-zinc-500 dark:text-zinc-400">answered by you</span>
      {:else if prompt.routedTo === "parent" && !prompt.outcome}
        <span class="text-violet-700 dark:text-violet-400">for the parent agent</span>
      {/if}
    </span>
  {/snippet}
  {#snippet aside()}
    <StatusBadge status={prompt.outcome || "pending"} />
  {/snippet}
  {#if prompt.kind === InteractionKind.PERMISSION}
    <PermissionRequest toolName={prompt.toolName} requestJson={prompt.requestJson} related={undefined} />
  {:else if questions.length > 0}
    <dl class="grid gap-2 text-base/6 sm:text-sm/6">
      {#each questions as question (question.id)}
        <div class="grid gap-0.5">
          <dt class="font-medium text-zinc-900 dark:text-zinc-100">{question.question || question.header || "Question"}</dt>
          <dd class="text-zinc-600 dark:text-zinc-400">
            {#if answers[question.id]}{question.secret ? "Answered (hidden)" : answers[question.id]}{:else if prompt.outcome === "cancelled"}Dismissed{:else if question.options.length > 0}<span class="text-zinc-500 italic dark:text-zinc-400">Options: {question.options.map((o) => o.label).join(", ")}</span>{/if}
          </dd>
        </div>
      {/each}
    </dl>
  {:else}
    <StructuredView node={structureJson(prompt.requestJson)} />
  {/if}
  {#if prompt.responseJson && !answered && !isEmptyNode(response) && !(response.kind === "object" && response.fields.every((f) => isEmptyNode(f.node))) && !questions.some((q) => q.secret)}
    <Section label="Response"><StructuredView node={response} /></Section>
  {/if}
  <RawToggle
    parts={[
      { label: "Request", text: prompt.requestJson },
      { label: "Response", text: questions.some((q) => q.secret) ? "" : prompt.responseJson },
    ]}
  />
</ItemFrame>
