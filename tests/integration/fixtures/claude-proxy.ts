export const CLAUDE_PROXY_MODEL = "claude-fable-5-dd-fixture";

/** Simulates the CLI's discovery and inference against the configured endpoint. */
export function claudeProxyFixture() {
  if (process.env["FIXTURE_CLAUDE_PROXY"] !== "1") return undefined;
  const root = process.env["ANTHROPIC_BASE_URL"];
  const model = process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length);
  const fallback = { value: "default", displayName: "Default", description: "Default model" };
  const discovered = { value: CLAUDE_PROXY_MODEL, displayName: "Fixture proxy model", description: "Discovered model" };

  async function request(path: string, init: RequestInit): Promise<boolean> {
    if (!root) throw new Error("Expected the configured proxy URL");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${process.env["ANTHROPIC_AUTH_TOKEN"] ?? ""}`);

    try {
      const reply = await fetch(`${root}/v1/${path}`, { ...init, headers });
      await reply.body?.cancel();

      return reply.ok;
    } catch {
      return false;
    }
  }

  return {
    async models() {
      const online = await request("models", { headers: { "X-Fixture-Discovery": "claude" } });

      return online ? [fallback, discovered] : [fallback];
    },
    infer: () =>
      request("messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      }),
  };
}
