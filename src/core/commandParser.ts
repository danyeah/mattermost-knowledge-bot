import { extractFirstHashtag } from "../mattermost/helpers.js";

export interface ParsedCommand {
  /** "unknown" = mentioned without a recognized command; the handler replies
   * with a usage hint instead of saving (save now requires explicit `salva`). */
  subcommand: "save" | "help" | "status" | "search" | "unknown";
  explicitHashtag: string | null;
  searchQuery: string | null;
  raw: string;
}

export function parseCommand(textAfterMention: string): ParsedCommand {
  const trimmed = textAfterMention.trim();

  if (trimmed === "") {
    return { subcommand: "unknown", explicitHashtag: null, searchQuery: null, raw: textAfterMention };
  }

  const firstToken = (trimmed.split(/\s+/)[0] ?? "").toLowerCase();
  const rest = trimmed.slice(firstToken.length).trim();

  let subcommand: ParsedCommand["subcommand"];
  if (firstToken === "help" || firstToken === "aiuto") {
    subcommand = "help";
  } else if (firstToken === "status") {
    subcommand = "status";
  } else if (firstToken === "cerca" || firstToken === "search") {
    subcommand = "search";
  } else if (firstToken === "salva" || firstToken === "save") {
    subcommand = "save";
  } else {
    // Mentioned without an explicit command — don't save by accident.
    subcommand = "unknown";
  }

  const searchQuery =
    subcommand === "search" ? rest.replace(/^["']|["']$/g, "") : null;

  // For saves, the hashtag and topic hint come from the text after `salva`.
  const explicitHashtag = subcommand === "save" ? extractFirstHashtag(rest) : null;

  // Strip the command keyword from `raw` for saves so topic detection sees only
  // the topic hint (e.g. "Feature 2026"), not the "salva" keyword itself.
  const raw = subcommand === "save" ? rest : textAfterMention;

  return { subcommand, explicitHashtag, searchQuery, raw };
}
