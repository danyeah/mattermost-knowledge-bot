import { extractFirstHashtag } from "../mattermost/helpers.js";

export interface ParsedCommand {
  subcommand: "save" | "help" | "status";
  explicitHashtag: string | null;
  raw: string;
}

export function parseCommand(textAfterMention: string): ParsedCommand {
  const trimmed = textAfterMention.trim();

  if (trimmed === "") {
    return { subcommand: "save", explicitHashtag: null, raw: textAfterMention };
  }

  const firstToken = (trimmed.split(/\s+/)[0] ?? "").toLowerCase();
  let subcommand: ParsedCommand["subcommand"];
  if (firstToken === "help") {
    subcommand = "help";
  } else if (firstToken === "status") {
    subcommand = "status";
  } else {
    subcommand = "save";
  }

  const explicitHashtag = subcommand === "save" ? extractFirstHashtag(trimmed) : null;
  return { subcommand, explicitHashtag, raw: textAfterMention };
}
