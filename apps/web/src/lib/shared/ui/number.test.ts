import { expect, test } from "bun:test";
import { clampNumber, numberBound, parseNumber, stepNumber } from "./number.ts";
test("number editing accepts decimal separators and rejects nonnumeric or infinite text", () => {
  expect(parseNumber("1,25")).toBe(1.25);
  expect(parseNumber("-2.5")).toBe(-2.5);
  expect(parseNumber("1e3")).toBe(1000);
  for (const text of ["", " ", "-", "1e", "12abc", "Infinity", "1e999"]) expect(parseNumber(text)).toBeUndefined();
  expect(numberBound(null)).toBeUndefined();
});
test("number limits clamp typed values and stepping stays on the min/step grid", () => {
  expect(clampNumber(-1, 0, 59)).toBe(0);
  expect(clampNumber(60, 0, 59)).toBe(59);
  expect(stepNumber(59, 1, 1, 0, 59)).toBe(59);
  expect(stepNumber(0, -1, 1000, 0)).toBe(0);
  expect(stepNumber(1500, 1, 1000, 0)).toBe(2000);
  expect(stepNumber(1500, -1, 1000, 0)).toBe(1000);
  expect(stepNumber(0.2, 1, 0.1, 0)).toBe(0.3);
  expect(stepNumber(0.3, -1, 0.1, 0)).toBe(0.2);
  expect(stepNumber(undefined, 1, 1, 1, 10)).toBe(1);
  expect(stepNumber(undefined, 1, 1000, 0)).toBe(1000);
  expect(stepNumber(1, 1, 0, 0, 10)).toBe(2);
});
