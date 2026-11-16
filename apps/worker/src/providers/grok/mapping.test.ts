import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ThreadEventSchema } from "@canopy/contracts";
import { GrokEventMapper } from "./mapping.ts";

test("ACP context reports replace used/size independently of cumulative dollar cost", () => {
  const mapper = new GrokEventMapper("turn", "/repo");

  const usage = (used: number, size: number) => {
    const mapped = mapper.update({
      sessionUpdate: "usage_update",
      used,
      size,
      cost: { currency: "USD", amount: 2 },
    })[0];

    if (!mapped?.body) throw new Error("Expected mapped update");
    const event = create(ThreadEventSchema, { body: mapped.body });

    if (event.body.case !== "usageUpdated") throw new Error("Expected usage update");

    return event.body.value;
  };

  expect(usage(12000, 100000).contextUsage).toMatchObject({ usedTokens: 12000n, limitTokens: 100000n });
  expect(usage(1000, 100000).contextUsage?.usedTokens).toBe(1000n);
  expect(usage(0, 0).contextUsage).toMatchObject({ usedTokens: 0n });
  expect(usage(0, 0).contextUsage?.limitTokens).toBeUndefined();
  expect(usage(NaN, Infinity).contextUsage?.usedTokens).toBeUndefined();
  expect(usage(NaN, Infinity).contextUsage?.limitTokens).toBeUndefined();
  expect(usage(12000, 100000).usage?.costUsd).toBe(2);
});
