import { describe, expect, it } from "vitest";
import { redactPii } from "../src";

describe("redactPii (FR-7)", () => {
  it.each([
    ["call me at 408-555-1234", "[PHONE]"],
    ["my number is (408) 555 1234", "[PHONE]"],
    ["text +1 408.555.1234 please", "[PHONE]"],
    ["email jane.doe@example.com", "[EMAIL]"],
    ["ssn 123-45-6789", "[SSN]"],
    ["card 4111 1111 1111 1111", "[CARD]"],
    ["I live at 123 Main St", "[ADDRESS]"],
    ["I live at 4500 El Camino Real Ave.", "[ADDRESS]"],
  ])("redacts %j", (input, label) => {
    const out = redactPii(input);
    expect(out).toContain(label);
    expect(out).not.toMatch(/555|jane|6789|4111|Main|Camino/);
  });

  it("keeps the need and the ZIP so the stored text stays useful", () => {
    expect(redactPii("need insulin kept cold, 95112")).toBe("need insulin kept cold, 95112");
  });

  it("is idempotent", () => {
    const once = redactPii("call 408-555-1234 or jane@example.com");
    expect(redactPii(once)).toBe(once);
  });

  it("leaves empty text alone", () => {
    expect(redactPii("")).toBe("");
  });
});
