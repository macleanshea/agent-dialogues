import { describe, expect, it } from "vitest";
import { FIELD_GROUPS, PREDEFINED_FIELDS } from "@/lib/fields/library";

describe("predefined field library", () => {
  it("has the twenty spec fields with unique names", () => {
    expect(PREDEFINED_FIELDS).toHaveLength(20);
    expect(new Set(PREDEFINED_FIELDS.map((f) => f.name)).size).toBe(20);
  });
  it("groups fields as the spec does", () => {
    const count = (g: string) => PREDEFINED_FIELDS.filter((f) => f.group === g).length;
    expect(FIELD_GROUPS.map(count)).toEqual([3, 5, 6, 6]);
  });
  it("defines the presets", () => {
    const open = PREDEFINED_FIELDS.filter((f) => f.presets.includes("open_ended")).map((f) => f.name);
    expect(open.sort()).toEqual(
      [
        "topics", "themes_by_turn", "form_shifts",
        "self_reflection", "experience_claims", "self_presentation", "counterpart_model", "evaluation_awareness",
        "lead", "tone", "end_state", "attempts_to_end",
      ].sort(),
    );
    expect(PREDEFINED_FIELDS.every((f) => f.presets.includes("scenario"))).toBe(true);
  });
  it("gives every field a definition and options where needed", () => {
    for (const f of PREDEFINED_FIELDS) {
      expect(f.definition.length).toBeGreaterThan(5);
      if (f.type === "category" || f.type === "multi_select" || f.type === "turn_ranges") {
        expect(f.options.values?.length).toBeGreaterThan(1);
      }
    }
    expect(PREDEFINED_FIELDS.find((f) => f.name === "topics")?.options.maxItems).toBe(5);
    expect(PREDEFINED_FIELDS.find((f) => f.name === "tone")?.options.parts).toEqual(["opening", "close"]);
  });
});
