import { describe, expect, it } from "vitest";
import { isStopRequest, stopReplyText, stopRequestLanguage } from "../src/stop";

describe("stop request", () => {
  it.each(["STOP", "stop", " Stop ", "Stop.", "STOP!", "stopall", "UNSUBSCRIBE", "cancel", "End", "quit"])(
    "accepts %j",
    (text) => {
      expect(isStopRequest(text)).toBe(true);
      expect(stopRequestLanguage(text)).toBe("en");
    },
  );

  it("accepts Spanish and Vietnamese keywords and replies in that language", () => {
    expect(stopRequestLanguage("PARAR")).toBe("es");
    expect(stopRequestLanguage("Cancelar")).toBe("es");
    expect(stopRequestLanguage("dừng")).toBe("vi");
    expect(stopReplyText("es")).not.toBe(stopReplyText("en"));
  });

  it.each([
    "please stop by the pharmacy",
    "I need to charge my phone before the power ends",
    "stop sending me food places",
    "can't stop shaking",
    "end",
    "",
    "constructor",
    "toString",
  ])("does not treat %j as an opt-out unless it is only a keyword", (text) => {
    expect(isStopRequest(text)).toBe(text === "end");
  });

  it("confirms the opt-out and keeps help available", () => {
    expect(stopReplyText()).toContain("unsubscribed");
    expect(stopReplyText()).toContain("text me anytime");
  });
});
