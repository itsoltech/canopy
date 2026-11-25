import { expect, test } from "bun:test";
import { mcpCall } from "../../apps/gateway/src/bots/mcp.ts";
import { connectorResultFields } from "../../apps/gateway/src/bots/mcp-result.ts";
import { fakeConnector } from "./support/connector.ts";

test("remote MCP results keep bounded screenshots and retain reference metadata when an image is too large", async () => {
  const reference = { id: "reference-1", url: "https://example.test/reference-1" };
  const preview = { type: "image", mimeType: "image/png", data: "A".repeat(960_000) };
  const caption = { type: "text", text: "Reference preview" };

  let result = {
    content: [caption, preview],
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
        (json) => json.replaceAll(remote.secret, "[REDACTED]"),
      );

    const first = await call();
    expect(first).toEqual(result);
    const fields = connectorResultFields(first);
    expect(JSON.parse(fields.resultJson)).toEqual(result);
    expect(JSON.parse(fields.content)).toEqual({ ...result, content: [caption] });

    result = { ...result, content: [caption, { ...preview, data: "A".repeat(1_010_000) }, preview] };
    expect(await call()).toMatchObject({
      content: [caption, preview, { type: "text", text: expect.stringContaining("omitted 1 image") }],
      structuredContent: { references: [reference] },
    });

    result = { ...result, content: [{ type: "text", text: "ą".repeat(70_000) }, caption, preview] };
    expect(await call()).toMatchObject({
      content: [caption, preview, { type: "text", text: expect.stringContaining("1 other MCP result part") }],
      structuredContent: { references: [reference] },
    });

    result = { ...result, content: [caption, { ...preview, data: "A".repeat(1_010_000) }] };
    const metadataOnly = await call();

    expect(metadataOnly).toMatchObject({
      content: [caption, { type: "text", text: expect.stringContaining("omitted 1 image") }],
      structuredContent: { references: [reference] },
      isError: false,
    });
    expect(Buffer.byteLength(JSON.stringify(metadataOnly))).toBeLessThanOrEqual(100_000);

    result = {
      content: [{ type: "text", text: "ą".repeat(70_000) }],
      structuredContent: { references: [{ ...reference, url: "a".repeat(101_000) }] },
    };
    expect(await call()).toMatchObject({ isError: true });

    result = { content: [{ type: "text", text: remote.secret }], structuredContent: { references: [reference] } };
    expect(await call()).toEqual({ ...result, content: [{ type: "text", text: "[REDACTED]" }] });

    result = { ...result, content: [{ ...preview, data: "A".repeat(8_000_000) }] };
    expect(await call()).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("too large") }],
    });
  } finally {
    remote.close();
  }
});
