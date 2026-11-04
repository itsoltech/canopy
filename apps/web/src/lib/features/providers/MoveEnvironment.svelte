<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { Provider, ProviderProfileKind, type ui } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import { providerCall, harnessName } from "./instances.ts";

  let {
    instance,
    onsaved,
    class: className,
  }: {
    instance: ui.ProviderInstance;
    onsaved: (saved: ui.ProviderInstance | undefined) => void;
    class?: ClassValue;
  } = $props();

  const names = $derived(new Set(instance.env.map((v) => v.name.toUpperCase())));

  const detected = $derived(
    instance.kind === ProviderProfileKind.NATIVE &&
      (instance.harness === Provider.CLAUDE
        ? names.has("ANTHROPIC_BASE_URL") && (names.has("ANTHROPIC_AUTH_TOKEN") || names.has("ANTHROPIC_API_KEY"))
        : (names.has("OPENAI_BASE_URL") || names.has("CODEX_BASE_URL")) &&
          (names.has("OPENAI_API_KEY") || names.has("CLIPROXY_API_KEY"))),
  );

  let open = $state(false);
  let name = $state("");
  let failure = $state<string>();
  let busy = $state(false);

  async function move(event: SubmitEvent) {
    event.preventDefault();
    event.stopPropagation();
    busy = true;
    failure = undefined;

    try {
      const result = await providerCall("move", {
        harness: instance.harness,
        id: instance.id,
        expectedRevision: instance.revision,
        name,
      });

      open = false;
      onsaved(result.instance);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }
</script>

{#if detected}
  <Alert class={className} title="Proxy settings found in environment variables">
    <p>
      Move the saved URL and secret into a reusable proxy. The gateway moves the secret without sending it to your
      browser and removes the connection variables.
    </p>
    <div class="pt-3">
      <Button
        size="sm"
        onclick={() => {
          name = `${harnessName(instance.harness)} proxy`;
          open = true;
        }}>Move to a proxy</Button
      >
    </div>
  </Alert>
{/if}
<Dialog
  bind:open
  title="Move to a proxy"
  description="This instance will use the saved proxy from its next turn and keep its existing sessions."
>
  <form class="grid gap-4" onsubmit={move}>
    <Field label="Proxy and instance name"><Input name="move-name" bind:value={name} required /></Field>
    {#if failure}<Alert tone="error">{failure}</Alert>{/if}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button><Button
        variant="primary"
        type="submit"
        loading={busy}>Move to a proxy</Button
      >
    </div>
  </form>
</Dialog>
