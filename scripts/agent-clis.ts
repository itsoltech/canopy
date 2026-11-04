/** Shared by desktop and standalone/Docker builds: agent CLIs are prerequisites. */
export const noAgentClis: Bun.BunPlugin = {
  name: "canopy-no-agent-cli-bundles",
  setup(builder) {
    builder.onResolve(
      {
        filter:
          /^(?:@anthropic-ai\/(?:claude-code|claude-agent-sdk-(?:linux|darwin|win32))|@openai\/codex(?:$|[-/])|@vibe-kit\/grok-cli)/,
      },
      ({ path }) => {
        throw new Error(`Agent CLIs must be installed on the target machine, never bundled: ${path}`);
      },
    );
  },
};
