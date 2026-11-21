<script lang="ts">
  import type { Provider } from "@canopy/contracts";
  import { providerSettingsEditor } from "@canopy/domain/provider-settings-editor";
  import type { ClassValue } from "svelte/elements";
  import CodeEditor from "#lib/features/files/CodeEditor.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import { harnessKey } from "./instances.ts";
  import SettingsSection from "./SettingsSection.svelte";

  let {
    harness,
    value = $bindable(),
    worker,
    error,
    readonly = false,
    class: className,
  }: {
    harness: Provider;
    value: string;
    worker?: { name: string; inherited: string };
    error?: string | undefined;
    readonly?: boolean;
    class?: ClassValue;
  } = $props();

  const editor = $derived(providerSettingsEditor(harnessKey(harness).toLowerCase()));
</script>

{#if editor}
  <SettingsSection
    title={worker ? `CLI settings on ${worker.name}` : "CLI settings for all workers"}
    description={worker
      ? "Keys entered here override settings from All workers."
      : "Applies to workers that use this instance."}
    class={className}
  >
    <Field
      label={editor.filename}
      description={worker ? "Clear the editor to use the shared settings." : "Use Environment to store secrets."}
      {error}
    >
      {#key editor.filename}
        <CodeEditor
          text={value}
          fileName={editor.filename}
          wrap
          {readonly}
          field={{ placeholder: editor.example }}
          onchange={(next) => (value = next)}
        >
          {#snippet fallback()}
            <Textarea
              bind:value
              name="cli-settings"
              rows={5}
              placeholder={editor.example}
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              {readonly}
              class="font-mono sm:text-sm/6"
            />
          {/snippet}
        </CodeEditor>
      {/key}
    </Field>
    <div class="grid gap-1 text-sm/5 text-zinc-600 dark:text-zinc-400">
      {#if worker?.inherited.trim()}
        <Disclosure summaryClass="min-h-8 items-center" align="center">
          {#snippet summary()}View shared settings{/snippet}
          <pre
            class="max-h-40 overflow-auto rounded-md bg-zinc-950/5 p-3 font-mono wrap-anywhere whitespace-pre-wrap dark:bg-white/5">{worker.inherited}</pre>
        </Disclosure>
      {/if}
      <Disclosure summaryClass="min-h-8 items-center" align="center">
        {#snippet summary()}View supported keys{/snippet}
        <ul class="flex flex-wrap gap-x-3 gap-y-1 pl-6">
          {#each editor.keys as key (key)}
            <li class="min-w-0"><code class="font-mono wrap-anywhere">{key}</code></li>
          {/each}
        </ul>
      </Disclosure>
    </div>
  </SettingsSection>
{/if}
