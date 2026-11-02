import type { ResolvedProfile } from "../profiles.ts";

/** Grok titles are opt-in cheap API calls: no CLI tools, sessions or workspace context. */
export async function generateGrokText(input: { model: string; prompt: string }, profile: ResolvedProfile, signal: AbortSignal): Promise<string> {
  if (profile.kind !== "cliproxyapi" || !/^grok-3-mini(?:-fast)?$/.test(input.model)) throw new Error("Choose a cheap Grok API model for text generation");
  const base = profile.baseUrl.href.replace(/\/$/, "").replace(/\/v1$/, "");
  const response = await fetch(`${base}/v1/chat/completions`, { method: "POST", signal, redirect: "error",
    headers: { authorization: `Bearer ${profile.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: input.model, messages: [{ role: "user", content: input.prompt }], max_tokens: 120, stream: false }),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Text endpoint returned HTTP ${response.status}`); }
  const body = await response.json() as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
  if (body.choices?.[0]?.finish_reason !== "stop") throw new Error("Incomplete title response");
  return body.choices[0].message?.content ?? "";
}
