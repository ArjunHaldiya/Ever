import { describe, expect, it } from "vitest";
import { hashHandle, normalizeHandle } from "../src/hash";

describe("normalizeHandle", () => {
  it("normalizes US phone formats to the same value", () => {
    const expected = "+14085551234";
    expect(normalizeHandle("408-555-1234")).toBe(expected);
    expect(normalizeHandle("(408) 555-1234")).toBe(expected);
    expect(normalizeHandle("+1 408 555 1234")).toBe(expected);
    expect(normalizeHandle("14085551234")).toBe(expected);
  });

  it("lowercases email handles (iMessage can use Apple ID emails)", () => {
    expect(normalizeHandle("  Jane@Example.COM ")).toBe("jane@example.com");
  });
});

describe("hashHandle", () => {
  it("is a stable 64-char hex SHA-256", () => {
    const h = hashHandle("408-555-1234", "salt");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashHandle("+1 (408) 555-1234", "salt")).toBe(h);
  });

  it("depends on the salt", () => {
    expect(hashHandle("408-555-1234", "a")).not.toBe(hashHandle("408-555-1234", "b"));
  });

  it("does not contain the raw identifier", () => {
    expect(hashHandle("408-555-1234", "salt")).not.toContain("5551234");
  });

  it("refuses to hash without a salt", () => {
    expect(() => hashHandle("408-555-1234", "")).toThrow(/salt/i);
  });
});
