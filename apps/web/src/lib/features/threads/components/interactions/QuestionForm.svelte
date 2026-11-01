<script lang="ts">
  import Button from "#lib/shared/ui/Button.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import { answersJson, parseQuestions } from "./questions.ts";

  /** The agent asks one or more questions; options are radio choices, free text where allowed. */
  let { requestJson, busy, submit }: { requestJson: string; busy: boolean; submit: (answer: { answerJson?: string; cancelled?: boolean }) => void } = $props();
  const questions = $derived(parseQuestions(requestJson));
  let answers = $state<Record<string, string>>({});
  const complete = $derived(questions.every((q) => (answers[q.id] ?? "").trim()));
  const id = $props.id();
</script>

<form
  class="grid gap-4"
  onsubmit={(event) => {
    event.preventDefault();
    submit({ answerJson: answersJson(answers) });
  }}
>
  {#each questions as question, index (question.id)}
    <fieldset class="grid gap-2">
      <legend class="text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">
        {#if question.header}<span class="mr-1 text-zinc-500 dark:text-zinc-400">{question.header}:</span>{/if}{question.question || `Question ${index + 1}`}
      </legend>
      {#if question.options.length > 0}
        <div class="grid gap-1.5">
          {#each question.options as option, optionIndex (optionIndex)}
            <label class="flex cursor-pointer gap-3 rounded-lg p-2.5 ring-1 ring-zinc-950/10 has-checked:bg-zinc-950/2.5 has-checked:ring-zinc-950/40 has-focus-visible:outline-2 has-focus-visible:outline-blue-500 dark:ring-white/10 dark:has-checked:bg-white/5 dark:has-checked:ring-white/40">
              <span class="flex h-lh items-center text-base/6 sm:text-sm/6">
                <span class="group inline-grid size-5 grid-cols-1 sm:size-4">
                  <input
                    type="radio"
                    name="{id}-{question.id}"
                    value={option.label}
                    bind:group={answers[question.id]}
                    class="col-start-1 row-start-1 appearance-none rounded-full border border-zinc-300 bg-white checked:border-zinc-950 checked:bg-zinc-950 focus-visible:outline-none dark:border-white/10 dark:bg-white/5 dark:checked:border-white dark:checked:bg-white forced-colors:appearance-auto"
                  />
                  <span class="pointer-events-none col-start-1 row-start-1 size-[round(down,40%,1px)] self-center justify-self-center rounded-full bg-white group-not-has-checked:opacity-0 dark:bg-zinc-950"></span>
                </span>
              </span>
              <span class="text-base/6 sm:text-sm/6">
                <span class="font-medium text-zinc-950 dark:text-white">{option.label}</span>
                {#if option.description}<span class="block text-zinc-500 dark:text-zinc-400">{option.description}</span>{/if}
              </span>
            </label>
          {/each}
        </div>
      {/if}
      {#if question.other}
        <Field label={question.options.length > 0 ? "Or answer in your own words" : "Your answer"}>
          <Input name="{id}-{question.id}-text" type={question.secret ? "password" : "text"} autocomplete="off" bind:value={answers[question.id]} />
        </Field>
      {/if}
    </fieldset>
  {/each}
  <div class="flex flex-wrap gap-2">
    <Button type="submit" variant="primary" icon="paper-airplane" disabled={!complete} loading={busy}>Send answer</Button>
    <Button disabled={busy} onclick={() => submit({ cancelled: true })}>Skip</Button>
  </div>
</form>
