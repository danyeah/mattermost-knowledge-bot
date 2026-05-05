import { describe, it, expect } from "vitest";
import { buildDocument, parseExisting, type DocumentSections, type ChronologicalEntry } from "../../src/core/documentBuilder.js";

const emptySections: DocumentSections = {
  summary: null,
  decisions: null,
  technical_details: null,
  operational_notes: null,
  references: null,
};

const populatedSections: DocumentSections = {
  summary: "This is the summary.",
  decisions: "We decided to use TypeScript.",
  technical_details: "Uses better-sqlite3.",
  operational_notes: "Restart with docker compose.",
  references: "https://example.com",
};

const sampleEntry: ChronologicalEntry = {
  isoTimestamp: "2024-01-15T10:00:00.000Z",
  triggeredByUsername: "alice",
  permalinkUrl: "https://chat.example.com/team/pl/abc123",
  threadMessages: [
    {
      timestamp: "2024-01-15T09:55:00.000Z",
      username: "bob",
      message: "How do we handle auth?",
    },
    {
      timestamp: "2024-01-15T09:57:00.000Z",
      username: "alice",
      message: "We use JWT tokens.",
    },
  ],
};

describe("buildDocument", () => {
  it("all null sections produce _(empty)_ markers", () => {
    const doc = buildDocument({
      topicDisplayName: "Test Topic",
      lastAiUpdateIso: "2024-01-15T10:00:00.000Z",
      sections: emptySections,
      chronologicalLog: [],
    });
    const count = (doc.match(/\\_\(empty\)\_/g) ?? doc.match(/\(empty\)/g))?.length;
    expect(doc).toContain("_(empty)_");
    const emptyCount = (doc.match(/\(empty\)/g) ?? []).length;
    expect(emptyCount).toBe(5);
  });

  it("populated sections render headings and content", () => {
    const doc = buildDocument({
      topicDisplayName: "API Design",
      lastAiUpdateIso: "2024-01-15T10:00:00.000Z",
      sections: populatedSections,
      chronologicalLog: [sampleEntry],
    });
    expect(doc).toContain("# API Design");
    expect(doc).toContain("## Summary");
    expect(doc).toContain("This is the summary.");
    expect(doc).toContain("## Decisions");
    expect(doc).toContain("We decided to use TypeScript.");
    expect(doc).toContain("## Technical details");
    expect(doc).toContain("## Operational notes");
    expect(doc).toContain("## References");
    expect(doc).toContain("## Chronological log");
  });

  it("chronological log entry is rendered with thread messages", () => {
    const doc = buildDocument({
      topicDisplayName: "Auth",
      lastAiUpdateIso: "2024-01-15T10:00:00.000Z",
      sections: emptySections,
      chronologicalLog: [sampleEntry],
    });
    expect(doc).toContain("Saved by @alice");
    expect(doc).toContain("@bob: How do we handle auth?");
    expect(doc).toContain("@alice: We use JWT tokens.");
    expect(doc).toContain("[View original thread](https://chat.example.com/team/pl/abc123)");
  });
});

describe("parseExisting round-trip", () => {
  it("round-trips empty sections", () => {
    const doc = buildDocument({
      topicDisplayName: "Empty Doc",
      lastAiUpdateIso: "2024-01-15T10:00:00.000Z",
      sections: emptySections,
      chronologicalLog: [],
    });
    const { sections } = parseExisting(doc);
    expect(sections.summary).toBeNull();
    expect(sections.decisions).toBeNull();
    expect(sections.technical_details).toBeNull();
    expect(sections.operational_notes).toBeNull();
    expect(sections.references).toBeNull();
  });

  it("round-trips populated sections", () => {
    const doc = buildDocument({
      topicDisplayName: "Full Doc",
      lastAiUpdateIso: "2024-01-15T10:00:00.000Z",
      sections: populatedSections,
      chronologicalLog: [sampleEntry],
    });
    const { sections } = parseExisting(doc);
    expect(sections.summary).toBe("This is the summary.");
    expect(sections.decisions).toBe("We decided to use TypeScript.");
    expect(sections.technical_details).toBe("Uses better-sqlite3.");
    expect(sections.operational_notes).toBe("Restart with docker compose.");
    expect(sections.references).toBe("https://example.com");
  });

  it("belowSeparator is preserved for log entries", () => {
    const doc = buildDocument({
      topicDisplayName: "Log Doc",
      lastAiUpdateIso: "2024-01-15T10:00:00.000Z",
      sections: emptySections,
      chronologicalLog: [sampleEntry],
    });
    const { belowSeparator } = parseExisting(doc);
    expect(belowSeparator).toContain("Saved by @alice");
    expect(belowSeparator).toContain("@bob: How do we handle auth?");
  });

  it("'---' inside Summary section does NOT misinterpret as chronological separator", () => {
    const sectionsWithDash: DocumentSections = {
      ...emptySections,
      summary: "Part one.\n\n---\n\nPart two.",
    };
    const doc = buildDocument({
      topicDisplayName: "Dash Doc",
      lastAiUpdateIso: "2024-01-15T10:00:00.000Z",
      sections: sectionsWithDash,
      chronologicalLog: [sampleEntry],
    });
    const { sections, belowSeparator } = parseExisting(doc);
    expect(sections.summary).toContain("Part one.");
    expect(sections.summary).toContain("Part two.");
    expect(belowSeparator).toContain("Saved by @alice");
  });

  it("multiple log entries are preserved in belowSeparator", () => {
    const entry2: ChronologicalEntry = {
      isoTimestamp: "2024-01-16T11:00:00.000Z",
      triggeredByUsername: "charlie",
      permalinkUrl: "https://chat.example.com/team/pl/def456",
      threadMessages: [{ timestamp: "2024-01-16T11:00:00.000Z", username: "charlie", message: "Follow up." }],
    };
    const doc = buildDocument({
      topicDisplayName: "Multi Log",
      lastAiUpdateIso: "2024-01-16T11:00:00.000Z",
      sections: emptySections,
      chronologicalLog: [sampleEntry, entry2],
    });
    const { belowSeparator } = parseExisting(doc);
    expect(belowSeparator).toContain("Saved by @alice");
    expect(belowSeparator).toContain("Saved by @charlie");
  });
});

describe("section ordering", () => {
  it("sections parsed correctly regardless of extra whitespace", () => {
    const doc = buildDocument({
      topicDisplayName: "Order Test",
      lastAiUpdateIso: "2024-01-15T10:00:00.000Z",
      sections: populatedSections,
      chronologicalLog: [],
    });
    const { sections } = parseExisting(doc);
    expect(sections.technical_details).toBe("Uses better-sqlite3.");
    expect(sections.operational_notes).toBe("Restart with docker compose.");
  });
});
