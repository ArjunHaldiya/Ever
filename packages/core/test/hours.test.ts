import { describe, expect, it } from "vitest";
import { formatHours, isOpenAt, minutesOfDay, parseHours } from "../src";
import { ELEVEN_PM_PT, NOON_PT } from "./fixtures";

describe("parseHours", () => {
  it("parses 24/7 and windows", () => {
    expect(parseHours("24/7")).toEqual({ kind: "always" });
    expect(parseHours("08:00-22:00")).toEqual({ kind: "window", openMin: 480, closeMin: 1320 });
    expect(parseHours("00:00-24:00")).toEqual({ kind: "window", openMin: 0, closeMin: 1440 });
  });

  it.each(["", "soon", "25:00-26:00", "08:00-08:00", "08:99-10:00", "8-10"])(
    "rejects %j",
    (s) => expect(parseHours(s)).toBeNull(),
  );
});

describe("minutesOfDay / isOpenAt", () => {
  it("reads Pacific local time, not UTC", () => {
    expect(minutesOfDay(NOON_PT)).toBe(12 * 60);
    expect(minutesOfDay(ELEVEN_PM_PT)).toBe(23 * 60);
  });

  it("treats open as inclusive and close as exclusive", () => {
    const at = (iso: string) => new Date(iso);
    expect(isOpenAt("12:00-13:00", at("2026-10-23T19:00:00Z"))).toBe(true);
    expect(isOpenAt("11:00-12:00", at("2026-10-23T19:00:00Z"))).toBe(false);
  });

  it("handles windows that wrap past midnight", () => {
    expect(isOpenAt("20:00-06:00", ELEVEN_PM_PT)).toBe(true);
    expect(isOpenAt("20:00-06:00", NOON_PT)).toBe(false);
  });
});

describe("formatHours", () => {
  it("formats for humans", () => {
    expect(formatHours("24/7")).toBe("Open 24 hours");
    expect(formatHours("08:00-22:00")).toBe("8 AM-10 PM");
    expect(formatHours("00:00-24:00")).toBe("12 AM-12 AM");
    expect(formatHours("09:30-17:45")).toBe("9:30 AM-5:45 PM");
  });

  it("passes through unparseable input", () => {
    expect(formatHours("by appointment")).toBe("by appointment");
  });
});
