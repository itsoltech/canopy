<script lang="ts">
  import { isString, listOf, objectOf, parseObject, str, type JsonValue } from "#lib/shared/json.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import { parseNumber } from "#lib/shared/ui/number.ts";

  /** MCP elicitation: a message and a flat JSON-schema form (strings, numbers, booleans). */
  let {
    requestJson,
    busy,
    submit,
  }: { requestJson: string; busy: boolean; submit: (answer: { answerJson?: string; cancelled?: boolean }) => void } =
    $props();

  const request = $derived(parseObject(requestJson));
  const schema = $derived(objectOf(request["requestedSchema"] ?? request["schema"]));
  const required = $derived(new Set(listOf(schema["required"]).filter(isString)));

  const fields = $derived(
    Object.entries(objectOf(schema["properties"])).map(([name, spec]) => {
      const s = objectOf(spec);

      return {
        name,
        title: str(s["title"]) || name,
        description: str(s["description"]),
        type: str(s["type"]) || "string",
      };
    }),
  );

  function content(form: HTMLFormElement): string {
    const data = new FormData(form);
    const out: Record<string, JsonValue> = {};

    for (const field of fields) {
      const value = data.get(field.name);

      if (field.type === "boolean") out[field.name] = data.has(field.name);
      else if (isString(value) && value.trim()) {
        const answer = field.type === "number" || field.type === "integer" ? parseNumber(value) : value;

        if (answer !== undefined) out[field.name] = answer;
      }
    }

    return JSON.stringify(out);
  }
</script>

<form
  class="grid gap-4"
  onsubmit={(event) => {
    event.preventDefault();
    submit({ answerJson: content(event.currentTarget) });
  }}
>
  {#if str(request["message"])}<p class="text-base/6 text-zinc-800 sm:text-sm/6 dark:text-zinc-200">
      {str(request["message"])}
    </p>{/if}
  {#each fields as field (field.name)}
    {#if field.type === "boolean"}
      <Checkbox name={field.name} label={field.title} description={field.description} />
    {:else}
      <Field label={field.title} description={field.description} optional={!required.has(field.name)}>
        <Input
          name={field.name}
          type={field.type === "number" || field.type === "integer" ? "number" : "text"}
          required={required.has(field.name)}
        />
      </Field>
    {/if}
  {/each}
  <div class="flex flex-wrap gap-2">
    <Button type="submit" variant="primary" loading={busy}>Submit</Button>
    <Button disabled={busy} onclick={() => submit({ cancelled: true })}>Decline</Button>
  </div>
</form>
