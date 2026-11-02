import { test, expect } from "bun:test";
import { GrokClient } from "./index.ts";

test.skipIf(process.env["OA_LIVE"] !== "1")("installed Grok ACP handshake and session capabilities", async () => {
  const client = new GrokClient({ executable: process.env["OA_GROK_EXECUTABLE"] ?? "/home/nix/.local/bin/grok" });
  try {
    const info = await client.initialize();
    console.info("Grok ACP capabilities", JSON.stringify({ version: info.protocolVersion, capabilities: info.agentCapabilities, authMethods: info.authMethods }));
    expect(info.protocolVersion).toBe(1);
    // session/new is safe before authentication: discovers modes/catalog without model tokens.
    if (!process.env["XAI_API_KEY"]) return; // handshake only on devices without a login/key
    const session = await client.newSession(import.meta.dir);
    console.info("Grok session capabilities", JSON.stringify(session));
    expect(session.sessionId).toBeTruthy();
  } finally { await client.dispose(); }
}, 45_000);
