import { expect, test } from "bun:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { join } from "node:path";
import { dockerAvailable } from "@canopy/db/testing";
import { LogExporter, Logs, registeredLogs, verifiedLogChunks } from "@canopy/logs";
import { tempDir } from "@canopy/testing";
import { startTestGateway } from "./support/gateway.ts";

const root = tempDir("canopy-connector-oauth-start-");
const privateMarker = "fixture-provider-rejected-private-registration";

const failures = [
  { name: "discovery", stage: "discovery", status: 503 },
  { name: "issuer", stage: "discovery", status: 200 },
  { name: "unavailable", stage: "registration", status: 0 },
  { name: "registration", stage: "registration", status: 422 },
  { name: "redirect", stage: "registration", status: 307 },
] as const;

function failedProvider(scenario: () => (typeof failures)[number]["name"]) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const { origin, pathname } = new URL(request.url);
      const failure = scenario();

      switch (pathname) {
        case "/.well-known/oauth-protected-resource/mcp":
          return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
        case "/.well-known/oauth-authorization-server":
          if (failure === "discovery") return new Response(privateMarker, { status: 503 });

          return Response.json({
            issuer: failure === "issuer" ? `${origin}/unexpected-issuer` : origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            ...(failure !== "unavailable" && { registration_endpoint: `${origin}/register` }),
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          });
        case "/register":
          if (failure === "redirect") return Response.redirect(`${origin}/register-next`, 307);

          return Response.json({ error: "invalid_client_metadata", error_description: privateMarker }, { status: 422 });
        default:
          return new Response(null, { status: 404 });
      }
    },
  });
}

test.skipIf(!dockerAvailable)(
  "failed OAuth starts export the stage and registration status without provider data",
  async () => {
    const logs = new Logs(join(root, "logs"));
    let scenario: (typeof failures)[number]["name"] = "discovery";
    const provider = failedProvider(() => scenario);
    const origin = provider.url.origin;
    let gateway: Awaited<ReturnType<typeof startTestGateway>> | undefined;

    try {
      gateway = await startTestGateway({ log: (message) => logs.write("gateway", message) });

      const { account } = await gateway.api.saveConnectorAccount({
        connectorType: "custom",
        name: "OAuth diagnostics",
        url: `${origin}/mcp`,
        authKind: "oauth",
      });

      const request = {
        accountId: account!.id,
        redirectUri: "http://127.0.0.1:19112/api/connectors/oauth/callback",
        browserBinding: "r".repeat(43),
        desktop: true,
      };

      for (const failure of failures) {
        scenario = failure.name;

        const error = await gateway.api.beginConnectorOAuth(request, { timeoutMs: 5_000 }).then(
          () => undefined,
          (cause) => ConnectError.from(cause),
        );

        expect(error?.code).toBe(Code.InvalidArgument);
        expect(error?.rawMessage).toBe(
          failure.stage === "discovery"
            ? "Could not start OAuth. Check the server metadata."
            : "Could not start OAuth. Check the OAuth client registration.",
        );
      }

      await provider.stop(true);

      const network = await gateway.api.beginConnectorOAuth(request, { timeoutMs: 5_000 }).then(
        () => undefined,
        (cause) => ConnectError.from(cause),
      );

      expect(network?.code).toBe(Code.InvalidArgument);
      expect(network?.rawMessage).toBe("Could not reach the OAuth server. Check your network connection.");
      const raw = await Bun.file(join(logs.directory, "gateway.log")).text();

      expect(raw).toContain("oauth start failed stage discovery status 0 network ECONNREFUSED");
      expect(raw).not.toContain(privateMarker);
      expect(raw).not.toContain(origin);

      const exporter = new LogExporter(registeredLogs(logs.directory, ["gateway"]));

      const [source] = await exporter.export(
        join(root, "spool"),
        { hours: 1, legacy: false, bytes: 4096 },
        AbortSignal.timeout(5_000),
      );

      const contents = await Bun.file(source!.file).text();

      const chunks = async function* () {
        yield Buffer.from(contents);
      };

      const verified: Uint8Array[] = [];
      let omitted = 0;

      for await (const chunk of verifiedLogChunks(chunks(), "gateway", () => omitted++)) verified.push(chunk);
      expect(omitted).toBe(0);
      expect(Buffer.concat(verified).toString()).toBe(contents);

      for (const { stage, status } of failures) expect(contents).toContain(`"stage":"${stage}","status":${status}`);
      expect(contents).toContain('"stage":"discovery","status":0,"network":"ECONNREFUSED"');
      expect(contents).not.toContain(privateMarker);
      expect(contents).not.toContain(origin);
    } finally {
      provider.stop(true);
      await gateway?.close();
    }
  },
  60_000,
);
