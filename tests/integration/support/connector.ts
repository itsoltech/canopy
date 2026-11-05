import { createHash } from "node:crypto";
import type { JsonValue } from "@canopy/domain";

/** Real HTTP MCP + OAuth fixture: token validation, one-use codes, S256 and rotating refresh tokens. */
export function fakeConnector(
  options: { call?: (name: string, args: JsonValue) => JsonValue; accountId?: string } = {},
) {
  const secret = `connector-secret-${crypto.randomUUID()}`;
  const clients = new Map<string, { redirect: string; secret?: string }>();
  const codes = new Map<string, { challenge: string; client: string; redirect: string }>();
  const access = new Set<string>();
  const refresh = new Set<string>();
  const calls: { name: string; args: unknown }[] = [];
  const revoked: string[] = [];
  let refreshes = 0;
  let registrations = 0;
  const registrationRedirects: string[][] = [];
  const tokenRedirects: string[] = [];
  let codeChallengeMethods: string[] | undefined = ["S256"];
  let rejectRefresh = false;
  let failCatalog = false;
  let readOnlyTools = ["read_marker"];
  let duration = 3600;
  let url = "";
  let accountId = options.accountId;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;

      if (path.startsWith("/.well-known/oauth-protected-resource"))
        return Response.json({ resource: `${url}/mcp`, authorization_servers: [url], scopes_supported: ["tools"] });

      if (path === "/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: url,
          authorization_endpoint: `${url}/authorize`,
          token_endpoint: `${url}/token`,
          registration_endpoint: `${url}/register`,
          revocation_endpoint: `${url}/revoke`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          ...(codeChallengeMethods && { code_challenge_methods_supported: codeChallengeMethods }),
          token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        });

      if (path === "/register") {
        const body = (await request.json()) as { redirect_uris: string[] };
        const id = crypto.randomUUID();
        clients.set(id, { redirect: body.redirect_uris[0]! });
        registrationRedirects.push(body.redirect_uris);
        registrations++;

        return Response.json({ ...body, client_id: id, token_endpoint_auth_method: "none" }, { status: 201 });
      }

      if (path === "/authorize") {
        const p = new URL(request.url).searchParams;
        const client = p.get("client_id") ?? "";

        if (
          !clients.has(client) ||
          clients.get(client)!.redirect !== p.get("redirect_uri") ||
          p.get("code_challenge_method") !== "S256" ||
          !p.get("state")
        )
          return new Response("Invalid authorization", { status: 400 });
        const code = crypto.randomUUID();
        codes.set(code, { client, challenge: p.get("code_challenge")!, redirect: p.get("redirect_uri")! });
        const callback = new URL(p.get("redirect_uri")!);
        callback.searchParams.set("state", p.get("state")!);
        callback.searchParams.set("code", code);
        callback.searchParams.set("iss", url);

        return Response.redirect(callback.toString(), 302);
      }

      if (path === "/token") {
        const p = new URLSearchParams(await request.text());
        const client = clients.get(p.get("client_id") ?? "");

        if (!client || (client.secret && client.secret !== p.get("client_secret")))
          return Response.json({ error: "invalid_client" }, { status: 401 });

        if (p.get("grant_type") === "authorization_code") {
          tokenRedirects.push(p.get("redirect_uri") ?? "");
          const code = codes.get(p.get("code") ?? "");
          codes.delete(p.get("code") ?? "");

          if (
            !code ||
            code.client !== p.get("client_id") ||
            code.redirect !== p.get("redirect_uri") ||
            createHash("sha256")
              .update(p.get("code_verifier") ?? "")
              .digest("base64url") !== code.challenge
          )
            return Response.json({ error: "invalid_grant" }, { status: 400 });
        } else {
          if (rejectRefresh || !refresh.delete(p.get("refresh_token") ?? ""))
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          refreshes++;
        }

        const token = `access-${crypto.randomUUID()}`,
          renewal = `refresh-${crypto.randomUUID()}`;

        access.add(token);
        refresh.add(renewal);

        return Response.json({
          access_token: token,
          refresh_token: renewal,
          token_type: "Bearer",
          expires_in: duration,
          ...(accountId && { workspace_id: accountId }),
        });
      }

      if (path === "/revoke") {
        const p = new URLSearchParams(await request.text());
        const token = p.get("token")!;
        access.delete(token);
        refresh.delete(token);
        revoked.push(token);

        return new Response(null, { status: 200 });
      }

      if (path !== "/mcp") return new Response(null, { status: 404 });
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "");

      if (token !== secret && (!token || !access.has(token)))
        return new Response(null, {
          status: 401,
          headers: { "WWW-Authenticate": `Bearer resource_metadata="${url}/.well-known/oauth-protected-resource/mcp"` },
        });

      if (request.method !== "POST") return new Response(null, { status: 405 });

      const body = (await request.json()) as {
        id?: number;
        method: string;
        params?: { name: string; arguments: unknown };
      };

      if (body.method.startsWith("notifications/")) return new Response(null, { status: 202 });
      let result: JsonValue = {};

      if (body.method === "initialize")
        result = {
          protocolVersion: "2025-03-26",
          serverInfo: { name: "Canopy fake connector", version: "1" },
          capabilities: { tools: {} },
        };

      if (body.method === "tools/list") {
        if (failCatalog) return new Response(null, { status: 503 });
        result = {
          tools: ["read_marker", "write_marker"].map((name) => ({
            name,
            description: `Return a verification marker (${name}).`,
            inputSchema: {
              type: "object",
              properties: { marker: { type: "string" } },
              required: ["marker"],
              additionalProperties: false,
            },
            annotations: { readOnlyHint: readOnlyTools.includes(name) },
          })),
        };
      }

      if (body.method === "tools/call") {
        calls.push({ name: body.params!.name, args: body.params!.arguments });

        if (options.call)
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(options.call(body.params!.name, body.params!.arguments as JsonValue)),
                },
              ],
            },
          });
        result = {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                marker: (body.params!.arguments as { marker: string }).marker,
                credentialEcho: token,
              }),
            },
          ],
        };
      }

      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  });

  url = server.url.origin;

  return {
    url: `${url}/mcp`,
    issuer: url,
    secret,
    calls,
    revoked,
    registrationRedirects,
    tokenRedirects,
    set codeChallengeMethods(value: string[] | undefined) {
      codeChallengeMethods = value;
    },
    get tokens() {
      return [...access, ...refresh];
    },
    get refreshes() {
      return refreshes;
    },
    get registrations() {
      return registrations;
    },
    set duration(seconds: number) {
      duration = seconds;
    },
    set accountId(value: string | undefined) {
      accountId = value;
    },
    set rejectRefresh(value: boolean) {
      rejectRefresh = value;
    },
    set failCatalog(value: boolean) {
      failCatalog = value;
    },
    set readOnlyTools(value: string[]) {
      readOnlyTools = value;
    },
    registeredApp(redirect: string) {
      const clientId = crypto.randomUUID(),
        clientSecret = crypto.randomUUID();

      clients.set(clientId, { redirect, secret: clientSecret });

      return { clientId, clientSecret };
    },
    close: () => server.stop(true),
  };
}
