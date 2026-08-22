import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/phoenix-real-hourly.json";
import {
  buildHourlyCurve,
  classifyBand,
  rankWindows,
  type DayResult,
  type HourCurve,
} from "./engine";

const realDays = fixture.days as DayResult[];

describe("buildHourlyCurve", () => {
  it("calculates per-hour medians from the captured Phoenix response", () => {
    const curve = buildHourlyCurve(realDays)["phoenix-downtown"];

    expect(curve).toEqual([
      { hour: 6, mean: 29.8, min: 25.1, max: 33.2 },
      { hour: 12, mean: 37, min: 33.5, max: 40.3 },
      { hour: 18, mean: 37.9, min: 34.8, max: 41 },
    ]);
  });

  it("keeps sites separate and omits hours with no complete measurements", () => {
    const days: DayResult[] = [
      ...realDays,
      {
        siteId: "park",
        date: "2026-08-11",
        hours: {
          "6": { mean: 24, min: 20, max: 28 },
          "12": { mean: 31, min: 27, max: 35 },
        },
      },
      {
        siteId: "park",
        date: "2026-08-12",
        hours: {
          "6": { mean: 26, min: 22, max: 30 },
        },
      },
    ];
    const curves = buildHourlyCurve(days);

    expect(curves.park).toEqual([
      { hour: 6, mean: 25, min: 21, max: 29 },
      { hour: 12, mean: 31, min: 27, max: 35 },
    ]);
    expect(curves["phoenix-downtown"]).toHaveLength(3);
    expect(curves.park.some(({ hour }) => hour === 18)).toBe(false);
    expect(curves.park.some(({ mean }) => Number.isNaN(mean))).toBe(false);
  });

  it("returns empty curves for empty or unusable days", () => {
    expect(buildHourlyCurve([])).toEqual({});
    expect(
      buildHourlyCurve([
        { siteId: "empty", date: "2026-08-11", hours: {} },
      ]),
    ).toEqual({ empty: [] });
  });
});

describe("classifyBand", () => {
  it.each([
    [26.99, "Low"],
    [27, "Moderate"],
    [31.99, "Moderate"],
    [32, "High"],
    [36.99, "High"],
    [37, "Extreme"],
  ] as const)("classifies %s°C as %s", (temperature, expected) => {
    expect(classifyBand(temperature)).toBe(expected);
  });
});

describe("rankWindows", () => {
  it("sorts coolest to hottest and provides band reasons", () => {
    const curve: HourCurve[] = [
      { hour: 12, mean: 36.9, min: 33, max: 40 },
      { hour: 6, mean: 29.8, min: 25, max: 33 },
      { hour: 18, mean: 37.9, min: 35, max: 41 },
    ];

    const ranked = rankWindows(curve);

    expect(ranked.map(({ hour }) => hour)).toEqual([6, 12, 18]);
    expect(ranked.map(({ band }) => band)).toEqual(["Moderate", "High", "Extreme"]);
    expect(ranked[0].reason).toContain("29.8°C");
    expect(ranked[0].reason).toContain("cooler");
    expect(ranked[2].reason).toContain("hottest");
  });

  it("uses hour as a stable tie-breaker", () => {
    const ranked = rankWindows([
      { hour: 18, mean: 30, min: 25, max: 34 },
      { hour: 6, mean: 30, min: 25, max: 34 },
    ]);

    expect(ranked.map(({ hour }) => hour)).toEqual([6, 18]);
  });
});
