import { expect, test } from "bun:test";
import { burnInDays, verifyBetaAge, type PromotionRelease } from "./promote.ts";

test("stable burn-in starts when beta assets are complete and rejects young or incomplete releases", () => {
  const release: PromotionRelease = { tag_name: "v0.2.0-beta.1", draft: false, prerelease: true,
    published_at: "2026-11-01T00:00:00Z", assets: [{ name: "manifest.json", updated_at: "2026-11-02T00:00:00Z" }] };
  expect(() => verifyBetaAge(release, 3, Date.parse("2026-11-04T00:00:00Z"))).toThrow("burn-in");
  expect(() => verifyBetaAge(release, 3, Date.parse("2026-11-05T00:00:00Z"))).not.toThrow();
  expect(() => verifyBetaAge({ ...release, assets: [] }, 3)).toThrow("not ready");
  for (const input of ["-1", "1.5", "NaN", "366"]) expect(() => burnInDays(input)).toThrow();
  expect(burnInDays("3")).toBe(3);
});
