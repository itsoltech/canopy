import { randomBytes } from "node:crypto";

const labels = new Map([
  ["github", "GitHub"],
  ["notion", "Notion"],
  ["linear", "Linear"],
  ["atlassian", "Atlassian"],
  ["slack", "Slack"],
  ["microsoft", "Microsoft 365"],
  ["google", "Google Workspace"],
]);

/** Only fixed copy and allowlisted provider labels enter this credential-free document. */
export function connectorOAuthResult(connectorType: string | undefined, desktop: boolean): Response {
  const connected = connectorType !== undefined;
  const title = connected ? `${labels.get(connectorType) ?? "Account"} connected` : "Sign-in could not finish";

  const message = connected
    ? "You can close this tab and return to Canopy."
    : "Return to Canopy and reconnect the account to try again.";

  const nonce = randomBytes(18).toString("base64");
  const action = desktop ? "canopy://connectors" : "/settings/connectors";

  return new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Canopy</title><style nonce="${nonce}">
  :root { color-scheme: light dark; font-family: InterVariable, Inter, ui-sans-serif, system-ui, sans-serif; color: #18181b; background: #fff; -webkit-font-smoothing: antialiased; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 1.5rem; }
  main { width: 100%; max-width: 26rem; display: grid; gap: 1.25rem; }
  h1 { margin: 0; font-size: 1.5rem; font-weight: 600; letter-spacing: -.025em; text-wrap: balance; }
  p { margin: 0; color: #52525b; font-size: 1rem; line-height: 1.5; text-wrap: pretty; }
  .brand { font-size: .875rem; font-weight: 600; }
  a { justify-self: start; border-radius: .5rem; padding: .625rem .75rem; background: #18181b; color: #fff; text-decoration: none; font-size: .875rem; font-weight: 500; }
  a:hover { background: #3f3f46; }
  a:focus-visible { outline: 2px solid #0d9488; outline-offset: 3px; }
  @media (min-width: 40rem) { p { font-size: .875rem; } a { padding-block: .5rem; } }
  @media (prefers-color-scheme: dark) { :root { background: #18181b; color: #fafafa; } p { color: #a1a1aa; } a { background: #fafafa; color: #18181b; } a:hover { background: #d4d4d8; } }
</style></head><body><main aria-labelledby="result"><p class="brand">Canopy</p>
<h1 id="result">${title}</h1><p role="status">${message}</p>
<a href="${action}">${desktop ? "Open Canopy" : "Open connectors"}</a></main>
<script nonce="${nonce}">
  history.replaceState(null, "", "/api/connectors/oauth/callback");
  if (window.canopyDesktop) location.replace("/settings/connectors");
  else if (${desktop}) location.href = "canopy://connectors";
</script></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      },
    },
  );
}
