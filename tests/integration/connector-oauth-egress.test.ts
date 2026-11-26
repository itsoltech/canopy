import { describe, expect, test } from "bun:test";
import { discoverOAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import { BasicConstraintsExtension, SubjectAlternativeNameExtension, X509CertificateGenerator } from "@peculiar/x509";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { oauthEgress } from "../../apps/gateway/src/connectors/oauth-egress.ts";
import { OAuthConnectFailure } from "../../apps/gateway/src/connectors/oauth-network.ts";

const publicAnswer = { address: "1.1.1.1", family: 4 };
const publicV6 = { address: "2606:4700::1111", family: 6 };
const privateAnswer = { address: "10.1.2.3", family: 4 };

describe("OAuth address fallback", () => {
  const resource = "https://public.example.test/mcp";
  const token = new URL("/token", resource);

  test.each(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "ETIMEDOUT"] as const)(
    "falls back after TCP %s without another lookup, then prefers the working address",
    async (code) => {
      let resolutions = 0;
      const attempts: number[] = [];

      const transport = oauthEgress(resource, undefined, {
        resolve: async () => {
          resolutions++;

          return [publicV6, publicAnswer];
        },
        send: async (_url, address, request, _signal, body) => {
          attempts.push(address.family);
          expect(request.method).toBe("POST");
          expect(body?.toString()).toBe("grant_type=refresh_token");

          if (address.family === 6) throw new OAuthConnectFailure(code);

          return new Response(null, { status: 204 });
        },
      });

      for (let i = 0; i < 2; i++)
        expect((await transport.fetch(token, { method: "POST", body: "grant_type=refresh_token" })).status).toBe(204);
      expect(resolutions).toBe(1);
      expect(attempts).toEqual([6, 4, 4]);
    },
  );

  test("a pinned address can fall back to another validated address if a later TCP dial fails", async () => {
    const attempts: number[] = [];
    let disconnected = false;
    let resolutions = 0;

    const transport = oauthEgress(resource, undefined, {
      resolve: async () => {
        resolutions++;

        return [publicV6, publicAnswer];
      },
      send: async (_url, address) => {
        attempts.push(address.family);

        if (disconnected && address.family === 6) throw new OAuthConnectFailure("ECONNREFUSED");

        return new Response(null, { status: 204 });
      },
    });

    await transport.fetch(resource);
    disconnected = true;
    await transport.fetch(token, { method: "POST" });
    await transport.fetch(token, { method: "POST" });
    expect(resolutions).toBe(1);
    expect(attempts).toEqual([6, 6, 4, 4]);
  });

  test("never retries a POST after an ambiguous transport error even with a connect error code", async () => {
    const attempts: number[] = [];

    const transport = oauthEgress(resource, undefined, {
      resolve: async () => [publicV6, publicAnswer],
      send: async (_url, address) => {
        attempts.push(address.family);
        throw Object.assign(new Error("late transport failure"), { code: "ETIMEDOUT" });
      },
    });

    await expect(transport.fetch(token, { method: "POST", body: "code=fixture" })).rejects.toMatchObject({
      code: "transport",
    });
    expect(attempts).toEqual([6]);
  });

  test("dials the validated IP directly with TLS hostname verification and sends only one POST", async () => {
    const hostname = "oauth.example.invalid";
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);

    const certificate = await X509CertificateGenerator.createSelfSigned({
      name: `CN=${hostname}`,
      keys,
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
      extensions: [
        new BasicConstraintsExtension(true),
        new SubjectAlternativeNameExtension([{ type: "dns", value: hostname }]),
      ],
    });

    const cert = certificate.toString("pem");
    const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64");
    const trusted = getCACertificates();
    const received: string[] = [];

    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert, key: `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----\n` },
      async fetch(request) {
        received.push(request.headers.get("host") ?? "", await request.text());

        return new Response(null, { status: 204 });
      },
    });

    try {
      setDefaultCACertificates([...trusted, cert]);
      const host = `${hostname}:${provider.port}`;
      const url = `https://${host}/token`;

      const resolve = async () => [
        { address: "::1", family: 6 },
        { address: "127.0.0.1", family: 4 },
      ];

      expect(
        (await oauthEgress(url, undefined, { resolve }).fetch(url, { method: "POST", body: "code=fixture" })).status,
      ).toBe(204);
      const mismatched = `https://wrong.example.invalid:${provider.port}/token`;

      await expect(
        oauthEgress(mismatched, undefined, { resolve }).fetch(mismatched, { method: "POST" }),
      ).rejects.toMatchObject({ code: "transport" });
      expect(received).toEqual([host, "code=fixture"]);
    } finally {
      setDefaultCACertificates(trusted);
      await provider.stop(true);
    }
  });
});

describe("OAuth discovery and token traffic use the owner's network scope", () => {
  test("discovery cannot add a private issuer to the configured resource's authority", async () => {
    const resource = "https://public.example.test/mcp";
    const issuer = "https://issuer.example.test";
    const hosts: string[] = [];

    const transport = oauthEgress(resource, undefined, {
      resolve: async (host) => [host === "public.example.test" ? publicAnswer : privateAnswer],
      send: async (url) => {
        hosts.push(url.host);

        return Response.json({ resource, authorization_servers: [issuer] });
      },
    });

    await discoverOAuthServerInfo(resource, { fetchFn: transport.fetch }).catch(() => undefined);
    expect(hosts).toContain("public.example.test");
    expect(hosts).not.toContain("issuer.example.test");

    for (const path of ["/register", "/token", "/revoke"])
      await expect(transport.fetch(issuer + path, { method: "POST" })).rejects.toThrow("public address");
    expect(hosts).not.toContain("issuer.example.test");
  });

  test("only the exact private resource or registered issuer may receive requests", async () => {
    const calls: string[] = [];

    const transport = oauthEgress("http://127.0.0.1:9991/mcp", "https://issuer.internal:9992", {
      resolve: async () => [privateAnswer],
      send: async (url) => {
        calls.push(url.href);

        return new Response(null, { status: 204 });
      },
    });

    expect((await transport.fetch("http://127.0.0.1:9991/.well-known/oauth-protected-resource")).ok).toBe(true);
    expect((await transport.fetch("https://issuer.internal:9992/token", { method: "POST" })).ok).toBe(true);

    for (const url of ["http://127.0.0.1:9993/token", "https://issuer.internal:9993/token", "https://[::1]/register"])
      await expect(transport.fetch(url)).rejects.toThrow("public address");
    expect(calls).toHaveLength(2);
  });

  test("discarding a registered issuer blocks its previously resolved private address", async () => {
    const resource = "https://resource.example.test/mcp";
    const issuer = "https://issuer.internal";
    const requests: string[] = [];

    const transport = oauthEgress(resource, issuer, {
      resolve: async () => [privateAnswer],
      send: async (url) => {
        requests.push(url.pathname);

        return Response.json({});
      },
    });

    await transport.fetch(`${issuer}/.well-known/oauth-authorization-server`);
    transport.discardRegisteredIssuer();
    await expect(transport.fetch(`${issuer}/register`, { method: "POST" })).rejects.toThrow(
      "requires a public address",
    );
    expect(requests).toEqual(["/.well-known/oauth-authorization-server"]);
  });

  test("a public custom resource stays public when the callback opens another connection", async () => {
    const resource = "https://public.example.test/mcp";
    const send = async () => new Response(null, { status: 204 });
    const discovery = oauthEgress(resource, undefined, { resolve: async () => [publicAnswer], send });
    await discovery.fetch(resource);

    const callback = oauthEgress(resource, undefined, {
      publicOrigins: discovery.publicOrigins(),
      resolve: async () => [privateAnswer],
      send,
    });

    await expect(callback.fetch("https://public.example.test/token", { method: "POST" })).rejects.toThrow(
      "public address",
    );
  });

  test("the transport gets a pinned public address and rejects mixed and mapped private DNS answers", async () => {
    let resolutions = 0;
    const addresses: string[] = [];

    const transport = oauthEgress("https://public.example.test/mcp", undefined, {
      resolve: async (host) => {
        if (host === "mixed.example.test") return [publicAnswer, privateAnswer];

        if (host === "v6.example.test") return [{ address: "::ffff:10.1.2.3", family: 6 }];

        return [resolutions++ === 0 ? publicAnswer : privateAnswer];
      },
      send: async (url, selected) => {
        expect(url.host).toBe("issuer.example.test");
        addresses.push(selected.address);

        return new Response(null, { status: 204 });
      },
    });

    await transport.fetch("https://issuer.example.test/.well-known/oauth-authorization-server");
    await transport.fetch("https://issuer.example.test/register", { method: "POST" });
    expect(resolutions).toBe(1);
    expect(addresses).toEqual([publicAnswer.address, publicAnswer.address]);

    for (const host of ["mixed.example.test", "v6.example.test"])
      await expect(transport.fetch(`https://${host}/token`)).rejects.toThrow("public address");
  });
});
