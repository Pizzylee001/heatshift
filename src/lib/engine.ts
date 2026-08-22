export type HourMeasurement = {
  mean: number;
  min: number;
  max: number;
};

export type DayResult = {
  siteId: string;
  date: string;
  hours: Record<string, HourMeasurement | undefined>;
};

export type HourCurve = {
  hour: number;
  mean: number;
  min: number;
  max: number;
};

export type HourlyCurve = Record<string, HourCurve[]>;

export type TemperatureBand = "Low" | "Moderate" | "High" | "Extreme";

export type RankedWindow = HourCurve & {
  band: TemperatureBand;
  reason: string;
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function valuesForHour(
  days: DayResult[],
  hour: number,
  siteId: string,
  field: keyof HourMeasurement,
): number[] {
  return days
    .filter((day) => day.siteId === siteId)
    .map((day) => day.hours[String(hour)]?.[field])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

export function buildHourlyCurve(days: DayResult[]): HourlyCurve {
  const curves: HourlyCurve = {};
  const siteIds = [...new Set(days.map((day) => day.siteId))].sort();

  for (const siteId of siteIds) {
    const curve: HourCurve[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      const means = valuesForHour(days, hour, siteId, "mean");
      const mins = valuesForHour(days, hour, siteId, "min");
      const maxes = valuesForHour(days, hour, siteId, "max");
      if (means.length === 0 || mins.length === 0 || maxes.length === 0) continue;

      curve.push({ hour, mean: median(means), min: median(mins), max: median(maxes) });
    }
    curves[siteId] = curve;
  }

  return curves;
}

export function classifyBand(temperature: number): TemperatureBand {
  if (temperature < 27) return "Low";
  if (temperature < 32) return "Moderate";
  if (temperature < 37) return "High";
  return "Extreme";
}

function windowReason(window: HourCurve, band: TemperatureBand): string {
  const temperature = `${window.mean.toFixed(1)}°C`;
  switch (band) {
    case "Low":
      return `${temperature} is the coolest measured window for outdoor work.`;
    case "Moderate":
      return `${temperature} is comparatively cooler for outdoor work.`;
    case "High":
      return `${temperature} is warm; consider shifting work earlier or later.`;
    case "Extreme":
      return `${temperature} is the hottest range; consider avoiding this period.`;
  }
}

export function rankWindows(curve: HourCurve[]): RankedWindow[] {
  return [...curve]
    .sort((a, b) => a.mean - b.mean || a.hour - b.hour)
    .map((window) => {
      const band = classifyBand(window.mean);
      return { ...window, band, reason: windowReason(window, band) };
    });
}

export function formatWindow(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00-${String((hour + 1) % 24).padStart(2, "0")}:00`;
}
