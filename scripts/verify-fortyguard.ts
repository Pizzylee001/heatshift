import { writeFileSync } from "node:fs";

const BASE_URL = "https://api.fortyguard.com";
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 36;
const apiKey = process.env.FORTYGUARD_API_KEY;
const verifiedApiKey: string = apiKey ?? "";

type Position = [number, number];
type PolygonFeature = {
  type: "Feature";
  properties: { id: string };
  geometry: { type: "Polygon"; coordinates: Position[][] };
};
type MapFeature = { properties?: Record<string, unknown> };
type HeatmapResult = {
  map_data?: { features?: MapFeature[] };
  stats_data?: {
    n_cells?: number;
    temperature_stats?: { minimum?: number; maximum?: number; mean?: number };
  };
};
type ExperimentResult = {
  label: string;
  featureCount: number;
  nCells: number | null;
  propertyKeys: string[];
  hasTemperatures: boolean;
  result: HeatmapResult;
};

if (!apiKey) {
  throw new Error("FORTYGUARD_API_KEY is missing. Export it before running P0.");
}

function dateDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function squareFeature(id: string, lat: number, lng: number): PolygonFeature {
  const halfLat = 250 / 111_320;
  const halfLng = 250 / (111_320 * Math.cos((lat * Math.PI) / 180));
  const west = lng - halfLng;
  const east = lng + halfLng;
  const south = lat - halfLat;
  const north = lat + halfLat;

  return {
    type: "Feature",
    properties: { id },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ],
      ],
    },
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function submit(
  features: PolygonFeature[],
  date: string,
  time: string,
  filterType: 1 | 3,
): Promise<string> {
  const response = await fetch(`${BASE_URL}/v1/heatmap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": verifiedApiKey },
    body: JSON.stringify({
      polygon_aoi: { type: "FeatureCollection", features },
      date_time: { start_date: date, start_time: time, filter_type: filterType },
      granularity: 100,
    }),
  });
  const body = await readJson(response);

  if (!response.ok) {
    throw new Error(`Submission HTTP ${response.status}: ${JSON.stringify(body)}`);
  }

  const id = (body as { data?: { activity_id?: unknown } }).data?.activity_id;
  if (typeof id !== "string") {
    throw new Error(`Submission omitted activity_id: ${JSON.stringify(body)}`);
  }
  return id;
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function poll(activityId: string): Promise<HeatmapResult> {
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await wait(POLL_INTERVAL_MS);
    const response = await fetch(`${BASE_URL}/v1/status/${activityId}`, {
      headers: { "api-key": verifiedApiKey },
    });

    // New activity IDs can briefly be unavailable.
    if (response.status === 404) continue;

    const body = await readJson(response);
    if (!response.ok) {
      throw new Error(`Status HTTP ${response.status}: ${JSON.stringify(body)}`);
    }

    const data = (body as {
      data?: { status?: string; result?: HeatmapResult };
    }).data;
    if (data?.status === "Completed") return data.result ?? {};
    if (data?.status === "Failed") {
      throw new Error(`FortyGuard activity failed: ${activityId}`);
    }
  }

  throw new Error(
    `Activity timed out after ${MAX_POLL_ATTEMPTS} attempts: ${activityId}`,
  );
}

async function experiment(
  label: string,
  features: PolygonFeature[],
  date: string,
  time: string,
  filterType: 1 | 3,
): Promise<ExperimentResult> {
  const activityId = await submit(features, date, time, filterType);
  console.log(`${label}: submitted ${activityId}`);
  const result = await poll(activityId);
  const mapFeatures = result.map_data?.features ?? [];
  const propertyKeys = [
    ...new Set(
      mapFeatures.flatMap((feature) => Object.keys(feature.properties ?? {})),
    ),
  ].sort();
  const hasTemperatures = mapFeatures.some((feature) => {
    const properties = feature.properties ?? {};
    return ["average_temperature", "min_temperature", "max_temperature"].every(
      (key) => typeof properties[key] === "number",
    );
  });

  return {
    label,
    featureCount: mapFeatures.length,
    nCells: result.stats_data?.n_cells ?? null,
    propertyKeys,
    hasTemperatures,
    result,
  };
}

async function main(): Promise<void> {
  const date = dateDaysAgo(10);
  const downtown = squareFeature("phoenix-downtown", 33.4484, -112.074);
  const park = squareFeature("phoenix-park", 33.4767, -112.0887);
  console.log(`FortyGuard P0 verification date: ${date}`);

  const fullDayPromise = experiment(
    "filter_type=3 full day", [downtown], date, "00:00", 3,
  );
  const hourlyPromise = Promise.all(
    Array.from({ length: 13 }, (_, index) => index + 6).map((hour) => {
      const time = `${String(hour).padStart(2, "0")}:00`;
      return experiment(`filter_type=1 ${time}`, [downtown], date, time, 1);
    }),
  );
  const multiPolygonPromise = experiment(
    "filter_type=1 two polygons", [downtown, park], date, "14:00", 1,
  );
  const [fullDay, hourly, multiPolygon] = await Promise.all([
    fullDayPromise, hourlyPromise, multiPolygonPromise,
  ]);

  console.table(
    [fullDay, ...hourly, multiPolygon].map(
      ({ label, featureCount, nCells, propertyKeys, hasTemperatures }) => ({
        experiment: label,
        features: featureCount,
        nCells,
        hasTemperatures,
        propertyKeys: propertyKeys.join(", "),
      }),
    ),
  );

  const populated = hourly.filter(
    ({ featureCount, hasTemperatures }) => featureCount > 0 && hasTemperatures,
  );
  const means = new Set(
    populated.map(({ result }) =>
      result.stats_data?.temperature_stats?.mean?.toFixed(4),
    ),
  );
  const hourlyResolution = populated.length >= 2 && means.size >= 2;
  const fullDayUsable = fullDay.featureCount > 0 && fullDay.hasTemperatures;
  const multiPolygonAccepted = multiPolygon.featureCount > 0;
  const mode = hourlyResolution
    ? "HOURLY_FILTER_TYPE_1"
    : fullDayUsable
      ? "FULL_DAY_FILTER_TYPE_3"
      : "UNVERIFIED";

  writeFileSync(
    "src/lib/apiConfig.ts",
    `// Generated by scripts/verify-fortyguard.ts after the P0 API probe.\nexport const HEATMAP_MODE = ${JSON.stringify(mode)} as const;\n`,
  );

  console.log("\nConclusion");
  console.log(`- Hourly resolution exists: ${hourlyResolution}`);
  console.log(`- filter_type=3 returns usable tiles: ${fullDayUsable}`);
  console.log(`- Two polygons accepted together: ${multiPolygonAccepted}`);
  console.log(`- Wrote HEATMAP_MODE=${mode} to src/lib/apiConfig.ts`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
