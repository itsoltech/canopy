import { sharedRead } from "#lib/shared/queries.svelte.ts";
import { create, type DescMessage, type MessageInitShape, type MessageShape } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";

/** Kind picker options; `compatibility` is the hint under the picker: which agents can use the kind. */
export const proxyKinds = [
  {
    value: "cliproxyapi",
    label: "CLIProxyAPI or a fork",
    description: "Claude, Codex and Grok through one connection.",
    compatibility: "Claude, Codex and Grok can all use it.",
  },
  {
    value: "anthropic",
    label: "Anthropic-compatible",
    description: "Messages API for Claude.",
    compatibility: "Only Claude can use it. Codex and Grok need an OpenAI-compatible proxy.",
  },
  {
    value: "openai",
    label: "OpenAI-compatible",
    description: "Responses API for Codex; Chat Completions for Grok.",
    compatibility: "Codex and Grok can use it. Claude needs an Anthropic-compatible proxy.",
  },
] as const;

export const supportsHarness = (proxy: ui.Proxy, harness: Provider) =>
  proxy.kind === "cliproxyapi" ||
  (proxy.kind === "anthropic" ? harness === Provider.CLAUDE : harness === Provider.CODEX || harness === Provider.GROK);

export const proxyActions = {
  save: [ui.SaveProxyRequestSchema, ui.ProxyResponseSchema],
  delete: [ui.ProxyIdRequestSchema, ui.DeleteProxyResponseSchema],
  test: [ui.ProxyIdRequestSchema, ui.TestProxyResponseSchema],
  accounts: [ui.RefreshProxyAccountsRequestSchema, ui.ProxyAccountsSchema],
} as const satisfies Record<string, readonly [DescMessage, DescMessage]>;

export type ProxyAction = keyof typeof proxyActions;

type RequestOf<A extends ProxyAction> = (typeof proxyActions)[A][0];

type ResponseOf<A extends ProxyAction> = (typeof proxyActions)[A][1];

export async function proxyCall<A extends ProxyAction>(
  action: A,
  input: MessageInitShape<RequestOf<A>>,
): Promise<MessageShape<ResponseOf<A>>> {
  const requestSchema: RequestOf<A> = proxyActions[action][0];
  const responseSchema: ResponseOf<A> = proxyActions[action][1];
  const message = create(requestSchema, input);

  return decode(responseSchema, await requestJson("POST", `/api/proxies/${action}`, encode(requestSchema, message)));
}

export async function listProxies(): Promise<ui.Proxy[]> {
  return decode(ui.ListProxiesResponseSchema, await requestJson("GET", "/api/proxies")).proxies;
}

/** The tab's one proxy list: the page and every picker share it; `proxiesChanged` reads it again. */
export const sharedProxies = () => sharedRead("ListProxies", ui.ListProxiesResponseSchema, "/api/proxies");

/** A saved or removed proxy, applied to the shared list at once. */
export function replaceProxy(read: ReturnType<typeof sharedProxies>, proxy: ui.Proxy, removed = false): void {
  const proxies = (read.data?.proxies ?? []).filter((p) => p.id !== proxy.id);
  read.set(create(ui.ListProxiesResponseSchema, { proxies: removed ? proxies : [...proxies, proxy] }));
}
