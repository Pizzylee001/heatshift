import { NextResponse } from "next/server";

const BASE_URL = "https://api.fortyguard.com";
const MAX_CONCURRENCY = 12;
const MAX_POLL_ATTEMPTS = 36;
const POLL_INTERVAL_MS = 3_000;
const MAX_429_RETRIES = 4;
const DATE_BUDGET_MS = 150_000;

type Site = { id: string; lat: number; lng: number };
type Position = [number, number];
type HeatmapFeature = {
  properties?: {
    average_temperature?: unknown;
    min_temperature?: unknown;
    max_temperature?: unknown;
  };
};
type HeatmapResult = {
  map_data?: { features?: HeatmapFeature[] };
};
type SiteHourResult = { mean: number; min: number; max: number };
type Job = { site: Site; hour: number };
type CachedResponse = {
  date: string;
  partial: boolean;
  sites: Record<string, Record<string, SiteHourResult>>;
};

const responseCache = new Map<string, CachedResponse>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isValidSite(value: unknown): value is Site {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 80 &&
    typeof value.lat === "number" &&
    Number.isFinite(value.lat) &&
    value.lat >= -90 &&
    value.lat <= 90 &&
    typeof value.lng === "number" &&
    Number.isFinite(value.lng) &&
    value.lng >= -180 &&
    value.lng <= 180
  );
}

function isValidHour(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 23;
}

function squarePolygon(lat: number, lng: number): Position[][] {
  const halfLat = 250 / 111_320;
  const halfLng = 250 / (111_320 * Math.cos((lat * Math.PI) / 180));
  const west = lng - halfLng;
  const east = lng + halfLng;
  const south = lat - halfLat;
  const north = lat + halfLat;
  const ring: Position[] = [[west, south], [east, south], [east, north], [west, north], [west, south]];
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

class ProxyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ProxyError";
  }
}

class BudgetStopped extends Error {}

function keyOf(siteId: string, hour: number): string {
  return `${siteId}:${hour}`;
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
  if (!response.ok) throw new ProxyError(`FortyGuard submission failed with HTTP ${response.status}.`, response.status);
  const activityId = isRecord(body) && isRecord(body.data) ? body.data.activity_id : undefined;
  if (typeof activityId !== "string" || activityId.length === 0) {
    throw new ProxyError("FortyGuard submission returned no activity id.", 502);
  }
  return activityId;
}

async function pollJob(activityId: string, apiKey: string, deadline: number, onBudgetEnd: () => void): Promise<HeatmapResult> {
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await sleep(POLL_INTERVAL_MS);
    if (Date.now() >= deadline) {
      onBudgetEnd();
      throw new BudgetStopped();
    }
    const response = await fetchWith429Backoff(`${BASE_URL}/v1/status/${activityId}`, { headers: { "api-key": apiKey } });
    if (response.status === 404) continue;
    const body = await readJson(response);
    if (!response.ok) throw new ProxyError(`FortyGuard status failed with HTTP ${response.status}.`, response.status);
    const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
    if (data?.status === "Completed") return isRecord(data.result) ? (data.result as HeatmapResult) : {};
    if (data?.status === "Failed") throw new ProxyError("FortyGuard activity failed.", 502);
  }
  throw new ProxyError("FortyGuard activity timed out.", 504);
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractMeasurements(result: HeatmapResult): SiteHourResult | null {
  const features = result.map_data?.features ?? [];
  if (features.length === 0) return null;
  const values = features
    .map((feature) => feature.properties)
    .filter((properties): properties is NonNullable<HeatmapFeature["properties"]> => properties !== undefined)
    .map((properties) => [toNumber(properties.average_temperature), toNumber(properties.min_temperature), toNumber(properties.max_temperature)])
    .filter((values): values is [number, number, number] => values.every((value) => value !== null));
  if (values.length === 0) return null;
  return {
    mean: values.reduce((sum, [average]) => sum + average, 0) / values.length,
    min: Math.min(...values.map(([, min]) => min)),
    max: Math.max(...values.map(([, , max]) => max)),
  };
}

async function runJob(job: Job, apiKey: string, date: string, deadline: number, onBudgetEnd: () => void): Promise<SiteHourResult | null> {
  const activityId = await submitJob(job, apiKey, date);
  return extractMeasurements(await pollJob(activityId, apiKey, deadline, onBudgetEnd));
}

async function runWithConcurrency(
  jobs: Job[],
  apiKey: string,
  date: string,
  onResult: ((job: Job, measurement: SiteHourResult) => void) | null,
): Promise<{ results: Map<string, SiteHourResult>; completedAll: boolean }> {
  const deadline = Date.now() + DATE_BUDGET_MS;
  const results = new Map<string, SiteHourResult>();
  let budgetEnded = false;
  const endBudget = () => { budgetEnded = true; };
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (!budgetEnded && nextIndex < jobs.length && Date.now() < deadline) {
      const job = jobs[nextIndex];
      nextIndex += 1;
      try {
        const measurement = await runJob(job, apiKey, date, deadline, endBudget);
        if (measurement) {
          results.set(keyOf(job.site.id, job.hour), measurement);
          onResult?.(job, measurement);
        }
      } catch (error) {
        if (error instanceof BudgetStopped) return;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, jobs.length) }, () => worker()));
  return { results, completedAll: !budgetEnded && results.size === jobs.length };
}

function collectSites(results: Map<string, SiteHourResult>, sites: Site[], hours: number[]): Record<string, Record<string, SiteHourResult>> {
  const payload: Record<string, Record<string, SiteHourResult>> = {};
  for (const site of sites) {
    const siteResults: Record<string, SiteHourResult> = {};
    for (const hour of hours) {
      const measurement = results.get(keyOf(site.id, hour));
      if (measurement) siteResults[String(hour)] = measurement;
    }
    payload[site.id] = siteResults;
  }
  return payload;
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof ProxyError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return NextResponse.json({ error: "Unable to complete the heat analysis." }, { status: 502 });
}

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.FORTYGUARD_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "FORTYGUARD_API_KEY is not configured." }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (!isRecord(body) || !Array.isArray(body.sites) || !Array.isArray(body.hours) || !isValidDate(body.date)) {
    return NextResponse.json({ error: "Expected { sites, date, hours } with a valid date." }, { status: 400 });
  }
  const sites = body.sites.filter(isValidSite);
  const hours = body.hours.filter(isValidHour);
  if (sites.length !== body.sites.length || sites.length < 1 || sites.length > 3) {
    return NextResponse.json({ error: "sites must contain 1 to 3 valid sites." }, { status: 400 });
  }
  if (hours.length !== body.hours.length || hours.length < 1 || hours.length > 24) {
    return NextResponse.json({ error: "hours must contain 1 to 24 valid hours." }, { status: 400 });
  }
  if (new Set(sites.map((site) => site.id)).size !== sites.length || new Set(hours).size !== hours.length) {
    return NextResponse.json({ error: "site ids and hours must be unique." }, { status: 400 });
  }

  const date = body.date as string;
  const wantsStream = body.stream === true;
  const cacheKey = JSON.stringify({ sites, date: body.date, hours: [...hours].sort((a, b) => a - b) });

  try {
    if (wantsStream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          try {
            const cached = responseCache.get(cacheKey);
            if (cached) {
              for (const [siteId, siteHours] of Object.entries(cached.sites)) {
                for (const [hourText, measurement] of Object.entries(siteHours)) {
                  send({ siteId, hour: Number(hourText), ...measurement });
                }
              }
              send({ done: true, date: cached.date, partial: cached.partial });
              return;
            }
            const jobs = sites.flatMap((site) => hours.map((hour) => ({ site, hour })));
            const { results, completedAll } = await runWithConcurrency(jobs, apiKey, date, (job, measurement) => {
              send({ siteId: job.site.id, hour: job.hour, ...measurement });
            });
            if (completedAll) {
              responseCache.set(cacheKey, { date: date, partial: false, sites: collectSites(results, sites, hours) });
            }
            send({ done: true, date: date, partial: !completedAll });
          } finally {
            controller.close();
          }
        },
      });
      return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
    }

    const cached = responseCache.get(cacheKey);
    if (cached) return NextResponse.json(cached);

    const jobs = sites.flatMap((site) => hours.map((hour) => ({ site, hour })));
    const { results, completedAll } = await runWithConcurrency(jobs, apiKey, date, null);
    const payload = { date: date, partial: !completedAll, sites: collectSites(results, sites, hours) };
    if (completedAll) responseCache.set(cacheKey, payload);
    return NextResponse.json(payload);
  } catch (error) {
    return errorResponse(error);
  }
}
