<script lang="ts">
  import { enhance } from "$app/forms";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";

  /** Name → project (redirects to it). `error` comes from the form action. */
  let { error, class: className }: { error?: string | undefined; class?: ClassValue } = $props();
  let busy = $state(false);
</script>

<form
  id="new-project"
  method="POST"
  action="/?/createProject"
  class={["flex scroll-mt-8 items-end gap-2", className]}
  use:enhance={() => {
    busy = true;
    return async ({ update }) => {
      await update();
      busy = false;
    };
  }}
>
  <Field label="New project" {error} class="min-w-0 flex-1">
    <Input name="name" placeholder="e.g. open-agents" required autocomplete="off" maxlength={200} />
  </Field>
  <Button type="submit" variant="primary" icon="plus" loading={busy} class={error ? "mb-7" : undefined}>Create</Button>
</form>
