import { describe, expect, test } from "bun:test";
import { splitStatements } from "./split.ts";

describe("splitStatements", () => {
  test("splits on semicolons and drops comment-only fragments", () => {
    expect(splitStatements("-- header\nCREATE TABLE a (x int);\n\n-- note\nCREATE TABLE b (y int);\n-- trailing")).toEqual([
      "-- header\nCREATE TABLE a (x int)",
      "-- note\nCREATE TABLE b (y int)",
    ]);
  });

  test("keeps semicolons inside strings, identifiers, comments and dollar quotes", () => {
    const script = `INSERT INTO t VALUES ('a;b', 'it''s;');
CREATE TABLE "we;ird" (x int); -- trailing; comment
/* block; comment */ SELECT 1;
CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;
CREATE FUNCTION g() RETURNS int LANGUAGE sql AS $body$ SELECT 1; $body$`;
    const parts = splitStatements(script);
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe("INSERT INTO t VALUES ('a;b', 'it''s;')");
    expect(parts[3]).toContain("BEGIN RETURN 1; END $$");
    expect(parts[4]).toContain("$body$ SELECT 1; $body$");
  });

  test("positional parameters are not dollar quotes", () => {
    expect(splitStatements("SELECT $1, $2; SELECT 3")).toEqual(["SELECT $1, $2", "SELECT 3"]);
  });

  test("fails loudly on unterminated quotes", () => {
    expect(() => splitStatements("SELECT 'oops")).toThrow("unterminated string");
    expect(() => splitStatements("DO $$ BEGIN")).toThrow("unterminated dollar quote");
  });
});
