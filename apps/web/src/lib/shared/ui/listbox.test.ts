import { describe, expect, test } from "bun:test";
import { moveOption, selectedIndex, selectTypeahead, type SelectOption } from "./listbox.ts";
const options: SelectOption[] = [
  { value: "ask", label: "Ask first" }, { value: "accept", label: "Accept edits", disabled: true },
  { value: "auto", label: "Auto" }, { value: "all", label: "All permissions" }, { value: "read", label: "Read only" },
];
describe("select listbox navigation", () => {
  test("arrows skip disabled choices and wrap", () => {
    expect(moveOption(options, 0, 1)).toBe(2);
    expect(moveOption(options, 2, -1)).toBe(0);
    expect(moveOption(options, 0, -1)).toBe(4);
    expect(moveOption([], -1, 1)).toBe(-1);
    expect(moveOption(options.map((o) => ({ ...o, disabled: true })), 0, 1)).toBe(-1);
  });
  test("active option follows bound values, including external updates", () => {
    expect(selectedIndex(options, "auto")).toBe(2);
    expect(selectedIndex(options, "read")).toBe(4);
    expect(selectedIndex(options, "accept")).toBe(0);
    expect(selectedIndex(options, "removed")).toBe(0);
    expect(selectedIndex([], "")).toBe(-1);
  });
  test("typeahead builds words, cycles repeated letters, skips disabled and expires", () => {
    const type = selectTypeahead();
    expect(type(options, 0, "a", 1000)).toBe(2);
    expect(type(options, 2, "a", 1100)).toBe(3);
    expect(type(options, 3, "a", 1200)).toBe(0);
    expect(type(options, 0, "r", 2000)).toBe(4);
    expect(type(options, 4, "e", 2100)).toBe(4);
    expect(type(options, 4, "a", 3000)).toBe(0);
    expect(type(options, 0, "u", 3100)).toBe(2);
    expect(type(options, 2, "z", 4000)).toBe(2);
  });
  test("typeahead matches accents and case", () => {
    expect(selectTypeahead()([{ value: "ecole", label: "École" }], -1, "E", 1000)).toBe(0);
  });
});
