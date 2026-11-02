import { redirect } from "@sveltejs/kit";
import { gateway } from "#lib/server/gateway.ts";
import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async ({ url, cookies, setHeaders }) => {
  setHeaders({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  let connected = false;
  try {
    const response = await gateway().completeConnectorOAuth({ state: url.searchParams.get("state") ?? "", code: url.searchParams.get("code") ?? "",
      error: url.searchParams.get("error") ?? "", issuer: url.searchParams.get("iss") ?? "", browserBinding: cookies.get("canopy-connector-oauth") ?? "" }, { timeoutMs: 60_000 });
    connected = !!response.account && !response.error;
  } catch { /* Codes, tokens and server error responses never enter logs or the redirect. */ }
  redirect(303, `/settings/connectors?connection=${connected ? "connected" : "error"}`);
};
