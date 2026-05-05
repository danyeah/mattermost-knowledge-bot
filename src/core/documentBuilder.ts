export interface DocumentSections {
  summary: string | null;
  decisions: string | null;
  technical_details: string | null;
  operational_notes: string | null;
  references: string | null;
}

export interface ChronologicalEntry {
  isoTimestamp: string;
  triggeredByUsername: string;
  permalinkUrl: string;
  threadMessages: Array<{ timestamp: string; username: string; message: string }>;
}

const CHRONOLOGICAL_MARKER = "\n---\n\n## Chronological log\n";
const EMPTY_MARKER = "_(empty)_";

function renderSection(content: string | null): string {
  return content && content.trim() ? content.trim() : EMPTY_MARKER;
}

function renderEntry(entry: ChronologicalEntry): string {
  const lines: string[] = [
    `### ${entry.isoTimestamp} — Saved by @${entry.triggeredByUsername}`,
    `[View original thread](${entry.permalinkUrl})`,
    "",
  ];
  for (const msg of entry.threadMessages) {
    lines.push(`> [${msg.timestamp}] @${msg.username}: ${msg.message}`);
  }
  return lines.join("\n");
}

export function buildDocument(opts: {
  topicDisplayName: string;
  lastAiUpdateIso: string;
  sections: DocumentSections;
  chronologicalLog: ChronologicalEntry[];
  belowSeparator?: string;
  appendEntry?: ChronologicalEntry;
}): string {
  const { topicDisplayName, lastAiUpdateIso, sections, chronologicalLog, belowSeparator, appendEntry } = opts;

  const parts: string[] = [
    `# ${topicDisplayName}`,
    "",
    `> Auto-curated knowledge document. Last AI update: ${lastAiUpdateIso}`,
    "",
    "## Summary",
    renderSection(sections.summary),
    "",
    "## Decisions",
    renderSection(sections.decisions),
    "",
    "## Technical details",
    renderSection(sections.technical_details),
    "",
    "## Operational notes",
    renderSection(sections.operational_notes),
    "",
    "## References",
    renderSection(sections.references),
    "",
    "---",
    "",
    "## Chronological log",
    "*Append-only. Never modified by AI.*",
    "",
  ];

  if (belowSeparator !== undefined) {
    // Update path: re-emit preserved raw log and append the new entry.
    const raw = belowSeparator.trim();
    if (raw) {
      parts.push(raw);
      parts.push("");
      parts.push("---");
      parts.push("");
    }
    if (appendEntry) {
      parts.push(renderEntry(appendEntry));
      parts.push("");
    }
  } else {
    for (let i = 0; i < chronologicalLog.length; i++) {
      if (i > 0) {
        parts.push("---");
        parts.push("");
      }
      parts.push(renderEntry(chronologicalLog[i]!));
      parts.push("");
    }
  }

  return parts.join("\n").trimEnd() + "\n";
}

export function parseExisting(markdown: string): {
  sections: DocumentSections;
  belowSeparator: string;
} {
  // User-edited Summary may contain '---' as a horizontal rule; only the chronological-log marker delimits the boundary.
  const markerIndex = markdown.indexOf(CHRONOLOGICAL_MARKER);

  let aboveSeparator = markdown;
  let belowSeparator = "";

  if (markerIndex !== -1) {
    aboveSeparator = markdown.slice(0, markerIndex);
    // Skip past the marker header line ("## Chronological log\n") and the next line ("*Append-only...*\n")
    const afterMarker = markdown.slice(markerIndex + CHRONOLOGICAL_MARKER.length);
    // Strip the "*Append-only.*" line if present
    const appendOnlyLine = "*Append-only. Never modified by AI.*\n";
    belowSeparator = afterMarker.startsWith(appendOnlyLine)
      ? afterMarker.slice(appendOnlyLine.length)
      : afterMarker;
  }

  // Build section map by splitting on heading boundaries.
  const headingBoundary = /\n## /;
  const headingParts = aboveSeparator.split(headingBoundary);
  const sectionMap = new Map<string, string>();
  for (const part of headingParts) {
    const newline = part.indexOf("\n");
    if (newline === -1) continue;
    const heading = part.slice(0, newline).trim();
    const body = part.slice(newline + 1).trim();
    sectionMap.set(heading, body);
  }

  function getSection(heading: string): string | null {
    const body = sectionMap.get(heading);
    if (body === undefined) return null;
    return body === EMPTY_MARKER || body === "" ? null : body;
  }

  const sections: DocumentSections = {
    summary: getSection("Summary"),
    decisions: getSection("Decisions"),
    technical_details: getSection("Technical details"),
    operational_notes: getSection("Operational notes"),
    references: getSection("References"),
  };

  return { sections, belowSeparator };
}
