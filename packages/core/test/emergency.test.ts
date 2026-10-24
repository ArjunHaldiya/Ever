import { describe, expect, it } from "vitest";
import { detectEmergency, emergencyReply } from "../src";

describe("detectEmergency", () => {
  it.each([
    "I can't breathe",
    "i cant breathe",
    "I CAN’T BREATHE",
    "he is not breathing",
    "she stopped breathing",
    "my dad has chest pain",
    "He's unconscious on the floor",
    "I think it was an overdose",
    "possible overdosed on pills",
    "trouble breathing and no power for my oxygen",
    "I think she is having a heart attack",
    "no puedo respirar",
    "tengo dolor de pecho",
    "mi madre está inconsciente",
    "tôi khó thở",
    "bố tôi đau ngực",
    "anh ấy bất tỉnh",
  ])("flags %j", (text) => {
    expect(detectEmergency(text)).toBe(true);
  });

  it.each([
    "my insulin needs a fridge",
    "where can I charge my phone near 95112",
    "I'm hungry and the power is out",
    "it's really hot in my apartment",
    "need a pharmacy open now",
    "",
  ])("does not flag %j", (text) => {
    expect(detectEmergency(text)).toBe(false);
  });
});

describe("emergencyReply", () => {
  it("tells the person to call 911 in every language", () => {
    expect(emergencyReply("en")).toContain("911");
    expect(emergencyReply("es")).toContain("911");
    expect(emergencyReply("vi")).toContain("911");
  });

  it("defaults to English", () => {
    expect(emergencyReply()).toBe(emergencyReply("en"));
  });
});
