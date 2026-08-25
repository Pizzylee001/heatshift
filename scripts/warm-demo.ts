import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildHourlyCurve } from "../src/lib/engine";

const BASE_URL = "https://api.fortyguard.com";
const MAX_CONCURRENCY = 12;
const MAX_POLL_ATTEMPTS = 36;
const POLL_INTERVAL_MS = 3_000;
const MAX_429_RETRIES = 4;
const DATE_BUDGET_MS = 150_000;
const DAY_LIMIT = 3;
const HOURS = Array.from({ length: 13 }, (_, index) => index + 6);

type Site = { id: string; name: string; lat: number; lng: number };
type Position = [number, number];
type HeatmapFeature = {
  properties?: {
    average_temperature?: unknown;
    min_temperature?: unknown;
    max_temperature?: unknown;
  };
};
type HeatmapResult = { map_data?: { features?: HeatmapFeature[] } };
type SiteHourResult = { mean: number; min: number; max: number };
type Job = { site: Site; hour: number };
type DayEntry = { siteId: string; date: string; hours: Record<string, SiteHourResult> };

const DEMO_SITES: Site[] = [
  { id: "demo-downtown", name: "Downtown asphalt core", lat: 33.4484, lng: -112.074 },
  { id: "demo-desert", name: "Desert edge, no irrigation", lat: 33.38, lng: -112.12 },
  { id: "demo-park", name: "Irrigated park area", lat: 33.48, lng: -112.01 },
];

function loadApiKey(): string {
  if (process.env.FORTYGUARD_API_KEY) return process.env.FORTYGUARD_API_KEY;
  let fromFile: string | undefined;
  try {
    const lines = readFileSync(".env.local", "utf8").split("\n");
    for (const line of lines) {
      const match = line.match(/^\s*FORTYGUARD_API_KEY\s*=\s*(.+?)\s*$/);
      if (match) {
        fromFile = match[1];
        break;
      }
    }
  } catch {
    fromFile = undefined;
  }
  if (!fromFile) throw new Error("FORTYGUARD_API_KEY missing: export it or add it to .env.local");
  return fromFile;
}

function isoDate(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchWith429Backoff(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt += 1) {
    const response = await fetch(input, init);
    if (response.status !== 429 || attempt === MAX_429_RETRIES) return response;
    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1_000, 30_000)
      : Math.min(1_000 * 2 ** attempt, 30_000);
    await sleep(waitMs);
  }
  throw new Error("Unreachable retry state");
}

class BudgetStopped extends Error {}
class JobError extends Error {}

function squarePolygon(lat: number, lng: number): Position[][] {
  const halfLat = 250 / 111_320;
  const halfLng = 250 / (111_320 * Math.cos((lat * Math.PI) / 180));
  const ring: Position[] = [
    [lng - halfLng, lat - halfLat],
    [lng + halfLng, lat - halfLat],
    [lng + halfLng, lat + halfLat],
    [lng - halfLng, lat + halfLat],
    [lng - halfLng, lat - halfLat],
  ];
  return [ring];
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function submitJob(job: Job, apiKey: string, date: string): Promise<string> {
  const response = await fetchWith429Backoff(`${BASE_URL}/v1/heatmap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": apiKey },
    body: JSON.stringify({
      polygon_aoi: {
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: { site_id: job.site.id }, geometry: { type: "Polygon", coordinates: squarePolygon(job.site.lat, job.site.lng) } }],
      },
      date_time: { start_date: date, start_time: `${String(job.hour).padStart(2, "0")}:00`, filter_type: 1 },
      granularity: 100,
    }), 
  });
  const body = await readJson(response);
  if (!response.ok) throw new JobError(`submit HTTP ${response.status}`);
  const activityId = typeof body === "object" && body !== null && "data" in body
    ? (body as { data?: { activity_id?: unknown } }).data?.activity_id
    : undefined;
  if (typeof activityId !== "string" || activityId.length === 0) throw new JobError("no activity id");
  return activityId;
}

async function pollJob(activityId: string, apiKey: string, deadline: number): Promise<HeatmapResult> {
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await sleep(POLL_INTERVAL_MS);
    if (Date.now() >= deadline) throw new BudgetStopped();
    const response = await fetchWith429Backoff(`${BASE_URL}/v1/status/${activityId}`, { headers: { "api-key": apiKey } });
    if (response.status === 404) continue;
    const body = await readJson(response);
    if (!response.ok) throw new JobError(`status HTTP ${response.status}`);
    const data = typeof body === "object" && body !== null && "data" in body
      ? (body as { data?: { status?: string; result?: HeatmapResult } }).data
      : undefined;
    if (data?.status === "Completed") return data.result ?? {};
    if (data?.status === "Failed") throw new JobError("activity failed");
  }
  throw new JobError("poll attempts exhausted");
}

function extractMeasurements(result: HeatmapResult): SiteHourResult | null {
  const features = result.map_data?.features ?? [];
  if (features.length === 0) return null;
  const values = features
    .map((feature) => feature.properties)
    .filter((properties): properties is NonNullable<HeatmapFeature["properties"]> => properties !== undefined)
    .map((properties) => [
      typeof properties.average_temperature === "number" && Number.isFinite(properties.average_temperature) ? properties.average_temperature : null,
      typeof properties.min_temperature === "number" && Number.isFinite(properties.min_temperature) ? properties.min_temperature : null,
      typeof properties.max_temperature === "number" && Number.isFinite(properties.max_temperature) ? properties.max_temperature : null,
    ])
    .filter((values): values is [number, number, number] => values.every((value) => value !== null));
  if (values.length === 0) return null;
  return {
    mean: values.reduce((sum, [average]) => sum + average, 0) / values.length,
    min: Math.min(...values.map(([, min]) => min)),
    max: Math.max(...values.map(([, , max]) => max)),
  };
}

const keyOf = (siteId: string, hour: number) => `${siteId}:${hour}`;

async function runJobsForDate(jobs: Job[], apiKey: string, date: string): Promise<Map<string, SiteHourResult>> {
  const deadline = Date.now() + DATE_BUDGET_MS;
  const results = new Map<string, SiteHourResult>();
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < jobs.length && Date.now() < deadline) {
      const job = jobs[nextIndex];
      nextIndex += 1;
      try {
        const activityId = await submitJob(job, apiKey, date);
        const measurement = extractMeasurements(await pollJob(activityId, apiKey, deadline));
        if (measurement) {
          results.set(keyOf(job.site.id, job.hour), measurement);
          console.log(`    ${date} landed ${results.size}/${jobs.length}`);
        }
      } catch (error) {
        if (error instanceof BudgetStopped) return;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, jobs.length) }, () => worker()));
  return results;
}

function writeDemoFile(days: DayEntry[], selectedDates: string[]): void {
  const payload = {
    generatedAt: new Date().toISOString(),
    source: "FortyGuard hyperlocal temperature archive (hourly, filter_type=1)",
    location: "Phoenix, AZ",
    sites: DEMO_SITES,
    datesUsed: selectedDates,
    days,
  };
  mkdirSync("data", { recursive: true });
  writeFileSync("data/demo-phoenix.json", `${JSON.stringify(payload, null, 2)}\n`);
  mkdirSync("public/data", { recursive: true });
  copyFileSync("data/demo-phoenix.json", "public/data/demo-phoenix.json");
}

async function main(): Promise<void> {
  const apiKey = loadApiKey();
  const candidates = Array.from({ length: 11 }, (_, index) => isoDate(index + 6));
  console.log(`Probing ${candidates.length} candidate dates for available archive days...`);
  const override = process.env.HEATSHIFT_KNOWN_DATES;
  const selectedDates: string[] = override
    ? override.split(",").map((value) => value.trim()).filter(Boolean).slice(0, DAY_LIMIT)
    : [];
  if (override) console.log(`Skipping probe; using known dates: ${selectedDates.join(", ")}`);
  for (const date of candidates) {
    if (override) break;
    if (selectedDates.length >= DAY_LIMIT) break;
    const startedAt = Date.now();
    let available = false;
    try {
      const activityId = await submitJob({ site: DEMO_SITES[0], hour: 12 }, apiKey, date);
      available = extractMeasurements(await pollJob(activityId, apiKey, Date.now() + DATE_BUDGET_MS)) !== null;
    } catch {
      available = false;
    }
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`  ${date}: ${available ? "available" : "empty"} (${seconds}s)`);
    if (available) selectedDates.push(date);
  }
  if (selectedDates.length === 0) throw new Error("No archive days with data were found; demo file not written.");

  let savedDays: DayEntry[] = [];
  try {
    const saved = JSON.parse(readFileSync("data/demo-phoenix.json", "utf8")) as { days?: DayEntry[] };
    if (Array.isArray(saved.days)) savedDays = saved.days;
  } catch {
    savedDays = [];
  }
  const isCached = (date: string) =>
    DEMO_SITES.every((site) =>
      savedDays.some((day) => day.siteId === site.id && day.date === date && Object.keys(day.hours).length > 0),
    );
  const days: DayEntry[] = savedDays.filter((day) => selectedDates.includes(day.date));
  for (const date of selectedDates) {
    if (isCached(date)) {
      console.log(`${date}: already cached from previous run`);
      continue;
    }
    const startedAt = Date.now();
    const jobs = DEMO_SITES.flatMap((site) => HOURS.map((hour) => ({ site, hour })));
    const results = await runJobsForDate(jobs, apiKey, date);
    for (const site of DEMO_SITES) {
      const hours: Record<string, SiteHourResult> = {};
      for (const hour of HOURS) {
        const measurement = results.get(keyOf(site.id, hour));
        if (measurement) hours[String(hour)] = measurement;
      }
      days.push({ siteId: site.id, date, hours });
    }
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`Fetched ${date}: ${results.size}/${jobs.length} hours landed (${seconds}s)`);
    writeDemoFile(days, selectedDates);
    console.log(`Progress saved (${days.length} site-days so far)`);
  }

  writeDemoFile(days, selectedDates);

  const curves = buildHourlyCurve(days);
  const sanity = Object.entries(curves)
    .map(([siteId, curve]) => `${siteId}:${curve.length}h`)
    .join(", ");
  console.log(`Engine sanity check -> ${sanity}`);
  console.log(`Wrote data/demo-phoenix.json (${days.length} site-days, dates: ${selectedDates.join(", ")})`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
