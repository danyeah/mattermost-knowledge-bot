import { describe, it, expect } from "vitest";
import { slugify } from "../../src/utils/slugify.js";

describe("slugify", () => {
  it("basic words", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("strips diacritics (French)", () => {
    expect(slugify("Café Frappé")).toBe("cafe-frappe");
  });

  it("strips diacritics (Italian)", () => {
    expect(slugify("Bilancio Nuovo Cliente")).toBe("bilancio-nuovo-cliente");
  });

  it("empty string → 'untitled'", () => {
    expect(slugify("")).toBe("untitled");
  });

  it("whitespace only → 'untitled'", () => {
    expect(slugify("   ")).toBe("untitled");
  });

  it("only special chars → 'untitled'", () => {
    expect(slugify("!!!")).toBe("untitled");
  });

  it("only dashes → 'untitled'", () => {
    expect(slugify("---")).toBe("untitled");
  });

  it("punctuation stripped", () => {
    expect(slugify("Hello! World!")).toBe("hello-world");
  });

  it("capped at 60 characters", () => {
    const input = "a".repeat(100);
    expect(slugify(input)).toBe("a".repeat(60));
  });

  it("emoji stripped, remaining text preserved", () => {
    expect(slugify("🚀 Launch")).toBe("launch");
  });

  it("numbers preserved with letters", () => {
    expect(slugify("API v2 Design")).toBe("api-v2-design");
  });

  it("consecutive separators collapsed", () => {
    expect(slugify("foo   bar")).toBe("foo-bar");
  });
});
