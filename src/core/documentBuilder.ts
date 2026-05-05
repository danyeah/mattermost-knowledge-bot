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

const SECTION_SEPARATOR = "---";
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
}): string {
  const { topicDisplayName, lastAiUpdateIso, sections, chronologicalLog } = opts;

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
    SECTION_SEPARATOR,
    "",
    "## Chronological log",
    "*Append-only. Never modified by AI.*",
    "",
  ];

  for (let i = 0; i < chronologicalLog.length; i++) {
    if (i > 0) {
      parts.push(SECTION_SEPARATOR);
      parts.push("");
    }
    parts.push(renderEntry(chronologicalLog[i]!));
    parts.push("");
  }

  return parts.join("\n").trimEnd() + "\n";
}

export function parseExisting(markdown: string): {
  sections: DocumentSections;
  chronologicalLog: ChronologicalEntry[];
  raw: { aboveSeparator: string; belowSeparator: string };
} {
  const separatorIndex = markdown.indexOf("\n---\n");

  let aboveSeparator = markdown;
  let belowSeparator = "";

  if (separatorIndex !== -1) {
    aboveSeparator = markdown.slice(0, separatorIndex);
    belowSeparator = markdown.slice(separatorIndex + 5);
  }

  function extractSection(sectionName: string, nextSectionName: string): string | null {
    const startMarker = `\n## ${sectionName}\n`;
    const start = aboveSeparator.indexOf(startMarker);
    if (start === -1) return null;

    const contentStart = start + startMarker.length;
    const endMarker = `\n## ${nextSectionName}`;
    const end = aboveSeparator.indexOf(endMarker, contentStart);
    const raw = end !== -1 ? aboveSeparator.slice(contentStart, end) : aboveSeparator.slice(contentStart);
    const trimmed = raw.trim();
    return trimmed === EMPTY_MARKER || trimmed === "" ? null : trimmed;
  }

  const sections: DocumentSections = {
    summary: extractSection("Summary", "Decisions"),
    decisions: extractSection("Decisions", "Technical details"),
    technical_details: extractSection("Technical details", "Operational notes"),
    operational_notes: extractSection("Operational notes", "References"),
    references: extractSection("References", "---"),
  };

  const chronologicalLog: ChronologicalEntry[] = [];

  if (belowSeparator) {
    const entryHeaderPattern = /^### (.+?) — Saved by @(\S+)$/m;
    const entryBlocks = belowSeparator.split(/\n---\n/);

    for (const block of entryBlocks) {
      const trimmedBlock = block.trim();
      if (!trimmedBlock) continue;

      const headerMatch = entryHeaderPattern.exec(trimmedBlock);
      if (!headerMatch) continue;

      const isoTimestamp = headerMatch[1]!;
      const triggeredByUsername = headerMatch[2]!;

      const linkMatch = /\[View original thread\]\((.+?)\)/.exec(trimmedBlock);
      const permalinkUrl = linkMatch ? linkMatch[1]! : "";

      const threadMessages: Array<{ timestamp: string; username: string; message: string }> = [];
      const msgPattern = /^> \[(.+?)\] @(\S+?): (.+)$/gm;
      let msgMatch: RegExpExecArray | null;
      while ((msgMatch = msgPattern.exec(trimmedBlock)) !== null) {
        threadMessages.push({
          timestamp: msgMatch[1]!,
          username: msgMatch[2]!,
          message: msgMatch[3]!,
        });
      }

      chronologicalLog.push({ isoTimestamp, triggeredByUsername, permalinkUrl, threadMessages });
    }
  }

  return { sections, chronologicalLog, raw: { aboveSeparator, belowSeparator } };
}
