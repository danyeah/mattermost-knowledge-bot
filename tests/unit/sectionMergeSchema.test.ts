import { describe, expect, it } from "vitest";
import { SectionMergeSchema } from "../../src/ai/schemas.js";

describe("SectionMergeSchema array coercion", () => {
  it("accepts plain string section bodies", () => {
    const parsed = SectionMergeSchema.parse({
      summary: "A summary",
      decisions: "- 2026-05-05 decision A\n- 2026-05-05 decision B",
      technical_details: null,
      operational_notes: null,
      references: null,
      change_summary: "added two decisions",
    });
    expect(parsed.decisions).toBe("- 2026-05-05 decision A\n- 2026-05-05 decision B");
  });

  it("coerces a JSON array of strings into a markdown bullet list", () => {
    const parsed = SectionMergeSchema.parse({
      summary: null,
      decisions: ["2026-05-04 - decision A", "2026-05-04 - decision B"],
      technical_details: null,
      operational_notes: null,
      references: null,
      change_summary: "captured two decisions",
    });
    expect(parsed.decisions).toBe("- 2026-05-04 - decision A\n- 2026-05-04 - decision B");
  });

  it("handles nested objects in the array by JSON-stringifying them", () => {
    const parsed = SectionMergeSchema.parse({
      summary: null,
      decisions: [{ date: "2026-05-04", text: "decision A" }],
      technical_details: null,
      operational_notes: null,
      references: null,
      change_summary: "x",
    });
    expect(parsed.decisions).toContain("- ");
    expect(parsed.decisions).toContain("decision A");
  });

  it("keeps null for unmodified sections", () => {
    const parsed = SectionMergeSchema.parse({
      summary: null,
      decisions: null,
      technical_details: null,
      operational_notes: null,
      references: null,
      change_summary: "no-op",
    });
    expect(parsed.summary).toBeNull();
  });

  it("rejects when change_summary is not a string", () => {
    expect(() =>
      SectionMergeSchema.parse({
        summary: null,
        decisions: null,
        technical_details: null,
        operational_notes: null,
        references: null,
        change_summary: null,
      }),
    ).toThrow();
  });
});
