import { describe, it, expect } from "vitest";
import { parseCommand } from "../../src/core/commandParser.js";

describe("parseCommand", () => {
  it("empty string → unknown (save requires an explicit command)", () => {
    const result = parseCommand("");
    expect(result.subcommand).toBe("unknown");
    expect(result.explicitHashtag).toBeNull();
  });

  it("whitespace only → unknown", () => {
    const result = parseCommand("  ");
    expect(result.subcommand).toBe("unknown");
    expect(result.explicitHashtag).toBeNull();
  });

  it("'help' → help subcommand, no hashtag", () => {
    const result = parseCommand("help");
    expect(result.subcommand).toBe("help");
    expect(result.explicitHashtag).toBeNull();
  });

  it("'HELP' → help (case insensitive)", () => {
    const result = parseCommand("HELP");
    expect(result.subcommand).toBe("help");
    expect(result.explicitHashtag).toBeNull();
  });

  it("'aiuto' → help (Italian alias)", () => {
    const result = parseCommand("aiuto");
    expect(result.subcommand).toBe("help");
  });

  it("'status' → status subcommand", () => {
    const result = parseCommand("status");
    expect(result.subcommand).toBe("status");
    expect(result.explicitHashtag).toBeNull();
  });

  it("'salva' → save, no hashtag", () => {
    const result = parseCommand("salva");
    expect(result.subcommand).toBe("save");
    expect(result.explicitHashtag).toBeNull();
  });

  it("'SALVA' → save (case insensitive)", () => {
    const result = parseCommand("SALVA");
    expect(result.subcommand).toBe("save");
  });

  it("'save' (English alias) → save", () => {
    const result = parseCommand("save");
    expect(result.subcommand).toBe("save");
  });

  it("'salva #api-design' → save with hashtag", () => {
    const result = parseCommand("salva #api-design");
    expect(result.subcommand).toBe("save");
    expect(result.explicitHashtag).toBe("api-design");
  });

  it("'salva Feature 2026' → save, raw stripped of command keyword", () => {
    const result = parseCommand("salva Feature 2026");
    expect(result.subcommand).toBe("save");
    expect(result.raw).toBe("Feature 2026");
    expect(result.explicitHashtag).toBeNull();
  });

  it("'save knowledge from this thread #api-design' → save with hashtag", () => {
    const result = parseCommand("save knowledge from this thread #api-design");
    expect(result.subcommand).toBe("save");
    expect(result.explicitHashtag).toBe("api-design");
  });

  it("'#client-onboarding' alone → unknown (no longer auto-saves)", () => {
    const result = parseCommand("#client-onboarding");
    expect(result.subcommand).toBe("unknown");
    expect(result.explicitHashtag).toBeNull();
  });

  it("free-text question → unknown (does not trigger a save)", () => {
    const result = parseCommand("che mi dici delle leghe?");
    expect(result.subcommand).toBe("unknown");
    expect(result.explicitHashtag).toBeNull();
  });

  it("'cerca come configuro il deploy' → search with query", () => {
    const result = parseCommand("cerca come configuro il deploy");
    expect(result.subcommand).toBe("search");
    expect(result.searchQuery).toBe("come configuro il deploy");
  });

  it("'search \"quoted query\"' → search, quotes stripped", () => {
    const result = parseCommand('search "quoted query"');
    expect(result.subcommand).toBe("search");
    expect(result.searchQuery).toBe("quoted query");
  });

  it("raw text is preserved as-is for unknown", () => {
    const input = "  #valid  ";
    const result = parseCommand(input);
    expect(result.subcommand).toBe("unknown");
    expect(result.raw).toBe(input);
  });
});
