import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { tempDirs } from "@canopy/testing";
import { OpenAiPricingCatalog } from "./model-catalog.ts";
import { openAiPriceFixture } from "../fixtures/openai-pricing.ts";

const temporary = tempDirs();
const DAY = 86_400_000;

test("catalog single-flights unknown models, persists daily freshness, misses and offline last-good backoff", async () => {
  const root = temporary("canopy-pricing-");
  const paths: string[] = [];
  let text = openAiPriceFixture;
  let status = 200;
  let now = 1_000_000;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      paths.push(new URL(request.url).pathname);
      await Bun.sleep(5);

      return new Response(text, { status, headers: { "last-modified": "Wed, 18 Nov 2026 00:00:00 GMT" } });
    },
  });

  const options = { source: `http://127.0.0.1:${server.port}/providers/openai/models/`, now: () => now };

  try {
    let cache = new OpenAiPricingCatalog(root, options);
    await Promise.all(Array.from({ length: 12 }, () => cache.prepare("fixture")));
    expect(paths).toEqual(["/providers/openai/models/fixture.toml"]);
    const first = cache.get("fixture");
    expect(first?.rates.cost.text.input.price).toBe(2);
    await cache.prepare("fixture");
    cache = new OpenAiPricingCatalog(root, options);
    await cache.prepare("fixture");
    expect(paths).toHaveLength(1);
    expect(cache.get("fixture")?.hash).toBe(first?.hash);

    status = 404;
    await Promise.all([cache.prepare("absent"), cache.prepare("absent")]);
    await cache.prepare("absent");
    cache = new OpenAiPricingCatalog(root, options);
    await cache.prepare("absent");
    expect(paths).toHaveLength(2);
    expect(cache.get("absent")).toBeUndefined();
    status = 200;
    await cache.prepare("another"); // A 404 does not block an unrelated valid model.
    expect(cache.get("another")).toBeDefined();
    expect(paths).toHaveLength(3);

    now += DAY + 1;
    status = 503;
    await cache.prepare("fixture");
    expect(cache.get("fixture")?.hash).toBe(first?.hash);
    cache = new OpenAiPricingCatalog(root, options);
    await cache.prepare("fixture");
    await cache.prepare("new-model");
    expect(paths).toHaveLength(4);
    expect(cache.get("fixture")?.hash).toBe(first?.hash);
    now += 300_001;
    status = 200;
    text = text.replace("price = 2\n", "price = 3\n");
    await cache.prepare("fixture");
    expect(cache.get("fixture")?.hash).not.toBe(first?.hash);
    expect(first?.rates.cost.text.input.price).toBe(2); // Held quotes are immutable snapshots.

    await Promise.all(
      ["../fixture", "openrouter/fixture", "openai/fixture", "fixture?other=1"].map((id) => cache.prepare(id)),
    );
    expect(paths).toHaveLength(5);
  } finally {
    await server.stop(true);
  }
});

test("invalid schema, foreign provider and oversized files cannot replace a cached price or reset failure cooldown", async () => {
  const root = temporary("canopy-pricing-invalid-");
  let text = openAiPriceFixture;
  let now = 1000;
  let requests = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests++;

      return new Response(text);
    },
  });

  const options = { source: `http://127.0.0.1:${server.port}/`, now: () => now };

  try {
    let cache = new OpenAiPricingCatalog(root, options);
    await cache.prepare("fixture");
    const hash = cache.get("fixture")?.hash;

    for (const invalid of [
      "not toml",
      openAiPriceFixture.replace("openai/fixture", "foreign/fixture"),
      "x".repeat(256_001),
    ]) {
      now += DAY + 1;
      text = invalid;
      await cache.prepare("fixture");
      cache = new OpenAiPricingCatalog(root, options);
      expect(cache.get("fixture")?.hash).toBe(hash);
      const before = requests;
      await cache.prepare("fixture");
      expect(requests).toBe(before);
    }
  } finally {
    await server.stop(true);
  }
});

test("catalog keeps a bounded durable model set", async () => {
  const root = temporary("canopy-pricing-bounded-");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(openAiPriceFixture) });

  try {
    const cache = new OpenAiPricingCatalog(root, { source: `http://127.0.0.1:${server.port}/` });

    for (let i = 0; i < 258; i++) await cache.prepare(`fixture-${i}`);
    expect(cache.get("fixture-0")).toBeUndefined();
    expect(cache.get("fixture-257")).toBeDefined();

    const disk = z
      .object({ entries: z.array(z.object({ id: z.string() })) })
      .parse(JSON.parse(readFileSync(join(root, "pricing", "openai.json"), "utf8")));

    expect(disk.entries).toHaveLength(256);
  } finally {
    await server.stop(true);
  }
});

test("a fresh cached model never waits for another model's in-flight HTTP lookup", async () => {
  const root = temporary("canopy-pricing-independent-");
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname === "/slow.toml") {
        started.resolve();
        await release.promise;
      }

      return new Response(openAiPriceFixture);
    },
  });

  const cache = new OpenAiPricingCatalog(root, { source: `http://127.0.0.1:${server.port}/` });
  let pending: Promise<void> | undefined;

  try {
    await cache.prepare("fixture");
    pending = cache.prepare("slow");
    await started.promise;
    let freshDone = false;

    const fresh = cache.prepare("fixture").then(() => {
      freshDone = true;
    });

    await Promise.resolve();
    expect(freshDone).toBe(true);
    expect(cache.get("slow")).toBeUndefined();
    await fresh;
  } finally {
    release.resolve();
    await pending;
    await server.stop(true);
  }
});
