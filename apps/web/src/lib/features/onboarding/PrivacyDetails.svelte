<script lang="ts">
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";

  const sections = [
    {
      title: "Who provides the agent",
      text: "Anthropic, OpenAI and xAI build and maintain the agents. Canopy starts the agent software on the worker you choose. Canopy manages thread history, approvals and access to its tools.",
    },
    {
      title: "Where task data goes",
      text: "Your gateway stores thread history and attachments. The agent can send task data to the configured model service. Check that service’s data policy for your account.",
    },
    {
      title: "What the agent can do",
      text: "The model proposes actions. The agent software carries them out using the access it has. Available actions depend on the permission mode, operating system and granted tools. Review changes and approval requests in the thread.",
    },
    {
      title: "Read only and data sharing",
      text: "Read only limits what the agent can change. The model service can still receive content the agent reads.",
    },
    {
      title: "How to share a secret",
      text: "Use the private secret card when an agent asks for a secret. For provider keys, use Settings → Providers or Settings → Proxies.",
    },
  ];
</script>

<div class="grid gap-5">
  {#each sections as { title, text } (title)}
    <section class="grid gap-1">
      <h2 class="text-base/6 font-medium text-ink">{title}</h2>
      <p class="text-base/6 text-muted sm:text-sm/6">{text}</p>
    </section>
  {/each}
  <Disclosure class="border-t border-divider pt-4" align="center">
    {#snippet summary()}<span class="text-base/6 font-medium text-ink">How the agents connect</span>{/snippet}
    <p class="pt-2 pl-6 text-base/6 text-muted sm:text-sm/6">
      Canopy uses the Claude Agent SDK to run Claude Code. It connects to Codex app-server and Grok CLI over standard
      input and output (stdio). Grok uses the Agent Client Protocol (ACP).
    </p>
  </Disclosure>
</div>
