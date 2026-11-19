export const CLAUDE_PROXY_MODEL = "claude-fable-5-dd-fixture";

/** Model aliases are reported by the SDK. A separate models request confirms their family and wire protocol. */
export function claudeProxyFixture() {
  if (process.env["FIXTURE_CLAUDE_PROXY"] !== "1") return undefined;
  const root = process.env["ANTHROPIC_BASE_URL"];
  const model = process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length);

  return {
    models: [
      { value: "default", displayName: "Default", description: "Default model" },
      { value: CLAUDE_PROXY_MODEL, displayName: "Fixture proxy model", description: "Discovered model" },
    ],
    infer: async () => {
      if (!root) throw new Error("Expected the configured proxy URL");

      try {
        const reply = await fetch(`${root}/v1/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env["ANTHROPIC_AUTH_TOKEN"] ?? ""}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model }),
        });

        await reply.body?.cancel();

        return reply.ok;
      } catch {
        return false;
      }
    },
  };
}
