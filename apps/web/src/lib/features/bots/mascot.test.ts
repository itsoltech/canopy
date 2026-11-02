import { describe, expect, test } from "bun:test";
import { eyeColor, mascotColors, mascotFor, mascotShapes, normalizeColor } from "./mascot.ts";

describe("selectable mascot registry", () => {
  test("all fourteen silhouettes have unique stable ids and closed SVG paths", () => {
    expect(mascotShapes.map((s) => s.id)).toEqual(["round", "cloud", "diamond", "spark", "clover", "blob", "flower", "droplet", "pill", "triangle", "square", "star", "hexagon", "pumpkin"]);
    expect(new Set(mascotShapes.map((s) => s.body)).size).toBe(14);
    for (const shape of mascotShapes) {
      expect(shape.body).toMatch(/^[Mm].*[Zz]$/);
      expect(shape.eyeY).toBeGreaterThan(10);
      expect(shape.eyeY).toBeLessThan(30);
    }
  });

  test("legacy generated identities still use the seven original silhouettes", () => {
    const bodies = new Set(Array.from({ length: 100 }, (_, i) => mascotFor(`existing-${i}`).shape.body));
    expect(bodies.size).toBe(7);
    expect(mascotFor("canopy")).toEqual(mascotFor("canopy"));
  });
});

describe("opaque mascot colour and eyes", () => {
  test("normalizes hex shorthand and rejects arbitrary CSS and transparency", () => {
    expect(normalizeColor("  #Af3 ")).toBe("#aaff33");
    expect(normalizeColor("A1B2C3")).toBe("#a1b2c3");
    for (const invalid of ["", "#ffff", "#ffffff00", "red", "var(--x)", "url(x)", "#gg0000"]) expect(normalizeColor(invalid)).toBeUndefined();
  });

  test("light eyes on dark bodies, dark eyes on very light bodies and readable midtones", () => {
    for (const dark of ["#000000", "#27272a", "#926344", "#0000ff"]) expect(eyeColor(dark)).toBe("#ffffff");
    for (const light of ["#ffffff", "#fef3c7", "#fbbf24", "#a3e635", "#00ff00"]) expect(eyeColor(light)).toBe("#18181b");
    // Presets cover both eye colours; each is chosen by relative luminance, not theme or hue.
    expect(new Set(mascotColors.map((c) => eyeColor(c.value))).size).toBe(2);
    expect(eyeColor("#777777")).toBe("#ffffff");
  });
});
