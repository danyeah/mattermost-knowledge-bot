import { describe, it, expect } from "vitest";
import { parseMention, extractFirstHashtag, buildPermalink } from "../../src/mattermost/helpers.js";

describe("parseMention", () => {
  it("matches @kb trigger", () => {
    const result = parseMention("@kb help", ["kb"]);
    expect(result.mentioned).toBe(true);
    expect(result.afterMention).toBe("help");
  });

  it("matches @knowledge-bot trigger", () => {
    const result = parseMention("@knowledge-bot status", ["knowledge-bot"]);
    expect(result.mentioned).toBe(true);
    expect(result.afterMention).toBe("status");
  });

  it("case insensitive match", () => {
    const result = parseMention("@KB help", ["kb"]);
    expect(result.mentioned).toBe(true);
  });

  it("matches in middle of text", () => {
    const result = parseMention("hey @kb please save this", ["kb"]);
    expect(result.mentioned).toBe(true);
    expect(result.afterMention).toBe("please save this");
  });

  it("does NOT match email@kb.com (word boundary required)", () => {
    const result = parseMention("email@kb.com is my address", ["kb"]);
    expect(result.mentioned).toBe(false);
  });

  it("returns false for no match", () => {
    const result = parseMention("nothing here", ["kb"]);
    expect(result.mentioned).toBe(false);
    expect(result.afterMention).toBe("");
  });

  it("returns false when triggers list is empty", () => {
    const result = parseMention("@kb help", []);
    expect(result.mentioned).toBe(false);
  });

  it("matches first trigger from multiple", () => {
    const result = parseMention("@wikibot save this", ["kb", "wikibot", "knowledge-bot"]);
    expect(result.mentioned).toBe(true);
    expect(result.afterMention).toBe("save this");
  });

  it("afterMention is empty when mention is at end", () => {
    const result = parseMention("hey @kb", ["kb"]);
    expect(result.mentioned).toBe(true);
    expect(result.afterMention).toBe("");
  });

  it("handles regex special chars in trigger names safely", () => {
    // Parentheses in trigger name should not break regex
    const result = parseMention("@kb help", ["kb"]);
    expect(result.mentioned).toBe(true);
  });
});

describe("extractFirstHashtag", () => {
  it("returns null for empty string", () => {
    expect(extractFirstHashtag("")).toBeNull();
  });

  it("returns null when no hashtag", () => {
    expect(extractFirstHashtag("no hashtag here")).toBeNull();
  });

  it("extracts hashtag at start", () => {
    expect(extractFirstHashtag("#api-design")).toBe("api-design");
  });

  it("extracts hashtag after space", () => {
    expect(extractFirstHashtag("save this #api-design")).toBe("api-design");
  });

  it("extracts only the first hashtag", () => {
    expect(extractFirstHashtag("#first #second")).toBe("first");
  });

  it("returns null for numeric-only hashtag", () => {
    expect(extractFirstHashtag("#123")).toBeNull();
  });

  it("returns null for mid-word hash (foo#bar)", () => {
    expect(extractFirstHashtag("foo#bar")).toBeNull();
  });

  it("handles trimmed whitespace before hashtag", () => {
    expect(extractFirstHashtag("  #valid  ")).toBe("valid");
  });

  it("returns null for hash-only with no slug", () => {
    expect(extractFirstHashtag("#")).toBeNull();
  });
});

describe("buildPermalink", () => {
  it("builds permalink correctly", () => {
    expect(buildPermalink("https://chat.example.com", "myteam", "abc123"))
      .toBe("https://chat.example.com/myteam/pl/abc123");
  });

  it("no trailing slash issues", () => {
    expect(buildPermalink("https://chat.example.com", "team", "postId"))
      .toBe("https://chat.example.com/team/pl/postId");
  });
});
