import { extractFirstHashtag } from "../mattermost/helpers.js";

export interface ParsedCommand {
  subcommand: "save" | "help" | "status" | "search";
  explicitHashtag: string | null;
  searchQuery: string | null;
  raw: string;
}

export function parseCommand(textAfterMention: string): ParsedCommand {
  const trimmed = textAfterMention.trim();

  if (trimmed === "") {
    return { subcommand: "save", explicitHashtag: null, searchQuery: null, raw: textAfterMention };
  }

  const firstToken = (trimmed.split(/\s+/)[0] ?? "").toLowerCase();
  let subcommand: ParsedCommand["subcommand"];
  if (firstToken === "help") {
    subcommand = "help";
  } else if (firstToken === "status") {
    subcommand = "status";
  } else if (firstToken === "cerca" || firstToken === "search") {
    subcommand = "search";
  } else {
    subcommand = "save";
  }

  const searchQuery =
    subcommand === "search"
      ? trimmed.slice(firstToken.length).trim().replace(/^["']|["']$/g, "")
      : null;

  const explicitHashtag = subcommand === "save" ? extractFirstHashtag(trimmed) : null;
  return { subcommand, explicitHashtag, searchQuery, raw: textAfterMention };
}
