import { describe, expect, test } from "bun:test";
import { SourceIndex } from "./source.ts";
import { gutterDigits, plainByDefault, sourceShape } from "./layout.ts";

describe("file reader layout known before indexing", () => {
  test.each(["", "a", "a\n", "a\nbb\n\nccc", "\n\n\n", "x".repeat(5000) + "\ny", "ą€😀\nżółw"])(
    "line count and longest line match the source index for %j",
    (text) => {
      const index = new SourceIndex(text);
      const shape = sourceShape(text);

      expect(shape.lines).toBe(index.lines);
      expect(shape.longest).toBe(index.longest);
      expect(shape.bytes).toBe(new TextEncoder().encode(text).length);
    },
  );

  test("short files share one gutter; long files widen it from the known count", () => {
    expect([1, 9, 10, 99, 999].map(gutterDigits)).toEqual([3, 3, 3, 3, 3]);
    expect(gutterDigits(1000)).toBe(4);
    expect(gutterDigits(123_456)).toBe(6);
  });

  test("large, long or wide files start as plain text", () => {
    expect(plainByDefault(sourceShape("a\n".repeat(100)))).toBe(false);
    expect(plainByDefault(sourceShape("a\n".repeat(10_000)))).toBe(true);
    expect(plainByDefault(sourceShape("x".repeat(2001)))).toBe(true);
    expect(plainByDefault(sourceShape("é".repeat(110 * 1024)))).toBe(true);
  });
});
