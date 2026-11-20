import { describe, expect, test } from "bun:test";
import { discoverOAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import { oauthEgress } from "../../apps/gateway/src/connectors/oauth-egress.ts";

const publicAnswer = { address: "1.1.1.1", family: 4 };
const privateAnswer = { address: "10.1.2.3", family: 4 };

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
