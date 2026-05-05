import { describe, it, expect } from "vitest";
import { parseCommand } from "../../src/core/commandParser.js";

describe("parseCommand", () => {
  it("empty string → save", () => {
    const result = parseCommand("");
    expect(result.subcommand).toBe("save");
    expect(result.explicitHashtag).toBeNull();
  });

  it("whitespace only → save", () => {
    const result = parseCommand("  ");
    expect(result.subcommand).toBe("save");
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

  it("'status' → status subcommand", () => {
    const result = parseCommand("status");
    expect(result.subcommand).toBe("status");
    expect(result.explicitHashtag).toBeNull();
  });

  it("'#client-onboarding' → save with hashtag", () => {
    const result = parseCommand("#client-onboarding");
    expect(result.subcommand).toBe("save");
    expect(result.explicitHashtag).toBe("client-onboarding");
  });

  it("'save knowledge from this thread #api-design' → save with hashtag", () => {
    const result = parseCommand("save knowledge from this thread #api-design");
    expect(result.subcommand).toBe("save");
    expect(result.explicitHashtag).toBe("api-design");
  });

  it("'#123' (numeric only) → save, no hashtag (must start with letter)", () => {
    const result = parseCommand("#123");
    expect(result.subcommand).toBe("save");
    expect(result.explicitHashtag).toBeNull();
  });

  it("'foo#bar' → save, no hashtag (no word boundary)", () => {
    const result = parseCommand("foo#bar");
    expect(result.subcommand).toBe("save");
    expect(result.explicitHashtag).toBeNull();
  });

  it("'  #valid  ' → save, hashtag 'valid'", () => {
    const result = parseCommand("  #valid  ");
    expect(result.subcommand).toBe("save");
    expect(result.explicitHashtag).toBe("valid");
  });

  it("'help #ignored' → help, hashtag null (cleared for non-save)", () => {
    const result = parseCommand("help #ignored");
    expect(result.subcommand).toBe("help");
    expect(result.explicitHashtag).toBeNull();
  });

  it("raw text is preserved as-is", () => {
    const input = "  #valid  ";
    const result = parseCommand(input);
    expect(result.raw).toBe(input);
  });
});
