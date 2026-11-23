import { expect, test } from "bun:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { join } from "node:path";
import { dockerAvailable } from "@canopy/db/testing";
import { LogExporter, Logs, registeredLogs, verifiedLogChunks } from "@canopy/logs";
import { tempDir } from "@canopy/testing";
import { startTestGateway } from "./support/gateway.ts";

const root = tempDir("canopy-connector-oauth-start-");

test.skipIf(!dockerAvailable)(
  "failed OAuth starts export the stage and registration status without provider data",
  async () => {
    const logs = new Logs(join(root, "logs"));
    const privateMarker = "fixture-provider-rejected-private-registration";
    let failDiscovery = true;

    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const { origin, pathname } = new URL(request.url);

        switch (pathname) {
          case "/.well-known/oauth-protected-resource/mcp":
            return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
          case "/.well-known/oauth-authorization-server":
            return failDiscovery
              ? new Response(privateMarker, { status: 503 })
              : Response.json({
                  issuer: origin,
                  authorization_endpoint: `${origin}/authorize`,
                  token_endpoint: `${origin}/token`,
                  registration_endpoint: `${origin}/register`,
                  response_types_supported: ["code"],
                  code_challenge_methods_supported: ["S256"],
                });
          case "/register":
            return Response.json(
              { error: "invalid_client_metadata", error_description: privateMarker },
              { status: 422 },
            );
          default:
            return new Response(null, { status: 404 });
        }
      },
    });

    let gateway: Awaited<ReturnType<typeof startTestGateway>> | undefined;

    try {
      gateway = await startTestGateway({ log: (message) => logs.write("gateway", message) });

      const { account } = await gateway.api.saveConnectorAccount({
        connectorType: "custom",
        name: "OAuth diagnostics",
        url: `${provider.url.origin}/mcp`,
        authKind: "oauth",
      });

      const request = {
        accountId: account!.id,
        redirectUri: "http://127.0.0.1:19112/api/connectors/oauth/callback",
        browserBinding: "r".repeat(43),
        desktop: true,
      };

      for (const fails of [true, false]) {
        failDiscovery = fails;

        const error = await gateway.api.beginConnectorOAuth(request, { timeoutMs: 5_000 }).then(
          () => undefined,
          (cause) => ConnectError.from(cause),
        );

        expect(error?.code).toBe(Code.InvalidArgument);
        expect(error?.rawMessage).toStartWith("Could not start OAuth");
      }

      expect(await Bun.file(join(logs.directory, "gateway.log")).text()).not.toContain(privateMarker);

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
      expect(contents).toContain('"stage":"discovery","status":503');
      expect(contents).toContain('"stage":"registration","status":422');
      expect(contents).not.toContain(privateMarker);
      expect(contents).not.toContain(provider.url.origin);
    } finally {
      provider.stop(true);
      await gateway?.close();
    }
  },
  60_000,
);
