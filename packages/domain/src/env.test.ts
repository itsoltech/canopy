import { expect, test } from "bun:test";
import { legacyEnvReader } from "./env.ts";

test("CANOPY_* wins, OA_* is a fallback with a single deprecation warning per process", () => {
  const warnings: string[] = [];
  const read = legacyEnvReader((message) => warnings.push(message));
  expect(read("CANOPY_PORT", { CANOPY_PORT: "1", OA_PORT: "2" })).toBe("1");
  expect(read("CANOPY_HOST", { CANOPY_HOST: "", OA_HOST: "x" })).toBe("");
  expect(warnings).toEqual([]);
  expect(read("CANOPY_PORT", { OA_PORT: "2" })).toBe("2");
  expect(read("CANOPY_HOST", { OA_HOST: "h" })).toBe("h");
  expect(read("CANOPY_TLS_KEY", {})).toBeUndefined();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("OA_PORT");
  expect(warnings[0]).toContain("CANOPY_PORT");
});
