<script lang="ts">
  import { enhance } from "$app/forms";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import Input from "#lib/shared/ui/Input.svelte";

  /** Name → project (redirects to its settings). `error` comes from the form action. */
  let { error, class: className }: { error?: string | undefined; class?: ClassValue } = $props();
  let busy = $state(false);
  const id = $props.id();
</script>

<form
  method="POST"
  action="/settings/projects?/createProject"
  class={["grid gap-2", className]}
  use:enhance={() => {
    busy = true;
    return async ({ update }) => {
      await update();
      busy = false;
    };
  }}
>
  <div class="flex gap-2">
    <label for="{id}-name" class="sr-only">Project name</label>
    <Input id="{id}-name" name="name" placeholder="Project name, e.g. open-agents" required autocomplete="off" maxlength={200} aria-invalid={Boolean(error) || undefined} aria-describedby={error ? `${id}-error` : undefined} />
    <Button type="submit" variant="primary" icon="plus" loading={busy}>Create</Button>
  </div>
  {#if error}<p id="{id}-error" class="text-sm/5 text-rose-700 dark:text-rose-400" role="alert">{error}</p>{/if}
</form>
