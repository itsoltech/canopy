import { expect, test } from "bun:test";
import { mcpCall } from "../../apps/gateway/src/bots/mcp.ts";
import { fakeConnector } from "./support/connector.ts";

test("remote MCP results keep bounded screenshots and retain reference metadata when an image is too large", async () => {
  const reference = { id: "reference-1", url: "https://example.test/reference-1" };
  const preview = { type: "image", mimeType: "image/png", data: "A".repeat(200_000) };

  let result = {
    content: [{ type: "text", text: "Reference preview" }, preview],
    structuredContent: { references: [reference] },
  };

  const remote = fakeConnector({
    response: (method, id) => (method === "tools/call" ? Response.json({ jsonrpc: "2.0", id, result }) : undefined),
  });

  try {
    const call = () =>
      mcpCall(
        {
          id: "fixture",
          name: "Reference connector",
          url: remote.url,
          transport: "http",
          enabled: true,
          headers: { Authorization: `Bearer ${remote.secret}` },
        },
        { name: "read_marker", description: "", parameters: {}, source: "mcp", remoteName: "read_marker" },
        {},
        AbortSignal.timeout(5000),
      );

    expect(await call()).toMatchObject(result);

    result = { ...result, content: [result.content[0]!, { ...preview, data: "A".repeat(1_010_000) }] };
    expect(await call()).toMatchObject({
      content: [
        { type: "text", text: "Reference preview" },
        { type: "text", text: expect.stringContaining("omitted") },
      ],
      structuredContent: { references: [reference] },
    });

    result = { ...result, content: [{ type: "text", text: "ą".repeat(70_000) }] };
    expect(await call()).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("structured result") }],
      structuredContent: { references: [reference] },
    });

    result = { ...result, structuredContent: { references: [{ ...reference, url: "a".repeat(101_000) }] } };
    expect(await call()).toMatchObject({ isError: true });
  } finally {
    remote.close();
  }
});
