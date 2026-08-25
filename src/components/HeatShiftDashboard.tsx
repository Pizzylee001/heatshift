"use client";

import dynamic from "next/dynamic";
import { useMemo, useState, type CSSProperties } from "react";
import {
  buildHourlyCurve,
  classifyBand,
  formatWindow,
  rankWindows,
  type DayResult,
  type HourCurve,
  type HourlyCurve,
  type TemperatureBand,
} from "../lib/engine";
import type { MapSite } from "./HeatMap";

const HeatMap = dynamic(() => import("./HeatMap"), {
  ssr: false,
  loading: () => <div className="map-loading shimmer" aria-label="Loading map" />,
});

type Site = MapSite;
type SiteHour = { mean: number; min: number; max: number };
type ApiResponse = { date: string; sites: Record<string, Record<string, SiteHour>> };
type StreamMeasurement = { siteId: string; hour: number; mean: number; min: number; max: number };
type StreamEvent = StreamMeasurement | { done: true; date: string; partial: boolean };

const DEMO_SITES: Site[] = [
  { id: "demo-downtown", name: "Downtown asphalt core", lat: 33.4484, lng: -112.074 },
  { id: "demo-desert", name: "Desert edge, no irrigation", lat: 33.38, lng: -112.12 },
  { id: "demo-park", name: "Irrigated park area", lat: 33.48, lng: -112.01 },
];
const HOURS = Array.from({ length: 13 }, (_, index) => index + 6);
const PROBE_HOUR = 12;
const LIVE_DAY_LIMIT = 2;
const PRECOMPUTED_URL = "/data/demo-phoenix.json";

function isoDate(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

const PROBE_CANDIDATES = Array.from({ length: 11 }, (_, index) => isoDate(index + 6));

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function bandClass(band: TemperatureBand): string {
  return `band-${band.toLowerCase()}`;
}

async function readStream(response: Response, onEvent: (event: StreamEvent) => void): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Streaming is not supported here.");
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      onEvent(JSON.parse(line) as StreamEvent);
    }
  }
}

function mergeMeasurement(
  current: DayResult[],
  siteId: string,
  date: string,
  measurement: StreamMeasurement,
): DayResult[] {
  const index = current.findIndex((day) => day.siteId === siteId && day.date === date);
  const next = [...current];
  if (index === -1) {
    next.push({ siteId, date, hours: { [String(measurement.hour)]: measurement } });
    return next;
  }
  next[index] = {
    ...next[index],
    hours: { ...next[index].hours, [String(measurement.hour)]: measurement },
  };
  return next;
}

function SiteCard({ site, curve, cardIndex }: { site: Site; curve: HourCurve[]; cardIndex: number }) {
  const [showEvidence, setShowEvidence] = useState(false);
  const ranked = useMemo(() => rankWindows(curve), [curve]);
  const values = new Map(curve.map((entry) => [entry.hour, entry]));

  return (
    <article className="site-card" style={{ "--card-delay": `${cardIndex * 300}ms` } as CSSProperties}>
      <div className="site-card-heading">
        <div>
          <div className="site-kicker"><span className="site-dot">{site.name.slice(0, 1)}</span> {site.name}</div>
          <h2>{site.lat.toFixed(4)}, {site.lng.toFixed(4)}</h2>
        </div>
        <span className="site-sample">{curve.length}/24 hrs</span>
      </div>

      <div className="hour-strip" aria-label={`Hourly temperature for ${site.name}`}> 
        {Array.from({ length: 24 }, (_, hour) => {
          const entry = values.get(hour);
          const band = entry ? classifyBand(entry.mean) : null;
          return (
            <div
              className={`hour-bar ${band ? bandClass(band) : "hour-missing"}`}
              key={hour}
              title={entry ? `${hourLabel(hour)} · ${entry.mean.toFixed(1)}°C` : `${hourLabel(hour)} · no data`}
              style={{ "--grow-delay": `${(cardIndex * 24 + hour) * 83}ms`, ...(entry ? { height: `${Math.max(22, Math.min(100, entry.mean * 2.2))}%` } : {}) } as CSSProperties}
            />
          );
        })}
      </div>
      <div className="hour-labels"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>

      <div className="section-label">Coolest windows</div>
      <div className="window-list">
        {ranked.slice(0, 5).map((window) => (
          <div className="window-row" key={window.hour}>
            <div className="window-time">{formatWindow(window.hour)}</div>
            <span className={`band-chip ${bandClass(window.band)}`}>{window.band}</span>
            <div className="window-copy">
              <strong>{window.mean.toFixed(1)}°C</strong>
              <span>{window.reason}</span>
            </div>
          </div>
        ))}
      </div>

      <button className="evidence-toggle" type="button" onClick={() => setShowEvidence((visible) => !visible)}>
        <span>{showEvidence ? "Hide measured evidence" : "Show measured evidence"}</span>
        <span aria-hidden="true">{showEvidence ? "−" : "+"}</span>
      </button>
      {showEvidence && (
        <div className="evidence-panel">
          <div className="evidence-head"><span>Hour</span><span>Mean</span><span>Min</span><span>Max</span></div>
          {curve.map((entry) => (
            <div className="evidence-row" key={entry.hour}>
              <span>{hourLabel(entry.hour)}</span>
              <strong>{entry.mean.toFixed(1)}°C</strong>
              <span>{entry.min.toFixed(1)}°C</span>
              <span>{entry.max.toFixed(1)}°C</span>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

export default function HeatShiftDashboard() {
  const [sites, setSites] = useState<Site[]>([]);
  const [dayResults, setDayResults] = useState<DayResult[]>([]);
  const [phase, setPhase] = useState<"idle" | "probing" | "loading" | "done">("idle");
  const [statusLine, setStatusLine] = useState("");
  const [usedDates, setUsedDates] = useState<string[]>([]);
  const [partialCount, setPartialCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [dataSource, setDataSource] = useState<"live" | "precomputed">("live");

  const curves = useMemo<HourlyCurve>(() => buildHourlyCurve(dayResults), [dayResults]);

  const summary = useMemo(() => {
    let best: { name: string; hour: number; mean: number } | null = null;
    for (const [siteId, curve] of Object.entries(curves)) {
      const site = sites.find((candidate) => candidate.id === siteId);
      if (!site || curve.length === 0) continue;
      const coolest = curve.reduce((a, b) => (b.mean < a.mean ? b : a));
      if (!best || coolest.mean < best.mean) best = { name: site.name, hour: coolest.hour, mean: coolest.mean };
    }
    return best;
  }, [curves, sites]);

  function showToast(message: string): void {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  }

  function isDemoSelection(): boolean {
    return sites.length === DEMO_SITES.length && DEMO_SITES.every((demo) => sites.some((site) => site.id === demo.id));
  }

  async function tryLoadPrecomputed(): Promise<boolean> {
    try {
      const response = await fetch(PRECOMPUTED_URL);
      if (!response.ok) return false;
      const payload = (await response.json()) as { days?: DayResult[]; datesUsed?: string[] };
      if (!payload.days || payload.days.length === 0) return false;
      setDayResults(payload.days);
      setUsedDates(payload.datesUsed ?? []);
      setPartialCount(0);
      setSkippedCount(0);
      setDataSource("precomputed");
      setError(null);
      setStatusLine("");
      setPhase("done");
      return true;
    } catch {
      return false;
    }
  }

  function addSite(lat: number, lng: number): void {
    if (phase !== "idle" && phase !== "done") return;
    if (sites.length >= 3) {
      showToast("max 3 sites");
      return;
    }
    const label = String.fromCharCode(65 + sites.length);
    setSites((current) => [...current, { id: `site-${label.toLowerCase()}`, name: `Site ${label}`, lat, lng }]);
    resetResults();
  }

  function resetResults(): void {
    setDayResults([]);
    setUsedDates([]);
    setPartialCount(0);
    setSkippedCount(0);
    setError(null);
    setDataSource("live");
    setPhase("idle");
    setStatusLine("");
  }

  function loadDemo(): void {
    if (phase === "probing" || phase === "loading") return;
    setSites(DEMO_SITES.map((site) => ({ ...site })));
    resetResults();
  }

  async function analyze(forceLive = false): Promise<void> {
    if (sites.length === 0) {
      showToast("Add at least one site");
      return;
    }
    if (!forceLive && isDemoSelection()) {
      const loaded = await tryLoadPrecomputed();
      if (loaded) return;
    }
    setDataSource("live");
    setError(null);
    setDayResults([]);
    setPartialCount(0);
    setSkippedCount(0);

    setPhase("probing");
    setStatusLine("Finding available archive days…");
    const selectedDates: string[] = [];
    for (const candidate of PROBE_CANDIDATES) {
      if (selectedDates.length >= LIVE_DAY_LIMIT) break;
      try {
        const response = await fetch("/api/fortyguard", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sites: [sites[0]], date: candidate, hours: [PROBE_HOUR] }),
        });
        if (!response.ok) continue;
        const payload = (await response.json()) as ApiResponse;
        const hasData = Object.values(payload.sites).some((hours) => Object.keys(hours).length > 0);
        if (hasData) selectedDates.push(candidate);
      } catch {
        continue;
      }
    }

    if (selectedDates.length === 0) {
      setError("No recent archive days returned data. Please try again later.");
      setPhase("idle");
      setStatusLine("");
      return;
    }
    setUsedDates(selectedDates);

    let landed = 0;
    const partialDates = new Set<string>();
    setPhase("loading");
    for (let index = 0; index < selectedDates.length; index += 1) {
      const date = selectedDates[index];
      const wasPartial = partialDates.size > 0;
      setStatusLine(`Fetching day ${index + 1} of ${selectedDates.length}${wasPartial ? " (partial)" : ""}…`);
      try {
        const response = await fetch("/api/fortyguard", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sites, date, hours: HOURS, stream: true }),
        });
        if (!response.ok || !response.body) {
          if ([401, 403, 429, 500].includes(response.status)) {
            setError("The archive is temporarily unavailable. Partial results shown.");
          }
          setSkippedCount((count) => count + 1);
          continue;
        }
        await readStream(response, (event) => {
          if ("done" in event) {
            if (event.partial) {
              partialDates.add(event.date);
              setPartialCount(partialDates.size);
            }
            return;
          }
          landed += 1;
          setDayResults((current) => mergeMeasurement(current, event.siteId, date, event));
        });
      } catch {
        setSkippedCount((count) => count + 1);
      }
    }

    setDataSource("live");
    if (landed === 0) setError("No hourly results landed. Please try again.");
    setPhase("done");
    setStatusLine("");
  }

  const busy = phase === "probing" || phase === "loading";

  return (
    <main className="mission-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">H</span>
          <div><div className="wordmark">HeatShift</div><div className="tagline">Plan around the heat.</div></div>
        </div>
        <div className="topbar-actions">
          <button className="demo-button" type="button" onClick={loadDemo} disabled={busy}>Load demo sites</button>
          <div className="header-status"><span className="status-dot" /> Live archive mode</div>
        </div>
      </header>

      <section className="hero-line">
        <div>
          <div className="eyebrow">FIELD PLANNING / PHOENIX, AZ</div>
          <h1>Find the cooler window.</h1>
          <p>Measured, hyperlocal temperature patterns for daylight work planning.</p>
        </div>
        <div className="header-meta"><span>06:00–18:00</span><small>Times as reported by data provider.</small></div>
      </section>

      <section className="control-grid">
        <div className="map-panel">
          <div className="panel-header"><div><span className="panel-label">SITE SELECTION</span><strong>{sites.length}/3 selected</strong></div><span className="panel-hint">Click map to add · click pin to remove</span></div>
          <HeatMap sites={sites} onAdd={addSite} onRemove={(id) => { setSites((current) => current.filter((site) => site.id !== id)); resetResults(); }} disabled={busy} />
          <div className="map-footer"><span>OpenStreetMap / FortyGuard archive</span><span>500 m site footprint</span></div>
        </div>
        <aside className="run-panel">
          <div className="panel-label">ANALYSIS RUN</div>
          <h2>Build a three-day heat profile.</h2>
          <p className="run-copy">The three most recent archive days with data are detected automatically before analysis.</p>
          <div className="run-specs"><div><span>Archive days</span><strong>Last 6–16 days</strong></div><div><span>Resolution</span><strong>Hourly</strong></div><div><span>Coverage</span><strong>06:00–18:00</strong></div></div>
          {(statusLine || error) && <div className="run-status">{statusLine}{error && <span className="error-text">{error}</span>}</div>}
          <button className="analyze-button" type="button" onClick={() => analyze(false)} disabled={busy}>
            {busy ? statusLine || "Working…" : phase === "done" ? "Refresh analysis" : "Analyze selected sites"}
            <span aria-hidden="true">→</span>
          </button>
          {toast && <div className="toast" role="status">{toast}</div>}
        </aside>
      </section>

      {phase === "loading" && (
        <section className="results-section">
          <div className="results-heading"><div><div className="eyebrow">PROCESSING ARCHIVE</div><h2>Reading measured heat</h2></div><span className="progress-count">{dayResults.length > 0 ? `${dayResults.length} readings` : "waiting…"}</span></div>
          <div className="loading-grid">{sites.map((site) => <div className="loading-card shimmer" key={site.id}><span>{site.name}</span><div /><div /></div>)}</div>
        </section>
      )}

      {phase === "done" && (
        <section className={`results-section ${dataSource === "precomputed" ? "animate-reveal" : ""}`}>
          <div className="results-heading">
            <div><div className="eyebrow">MEASURED EVIDENCE</div><h2>Heat profile by site</h2></div>
            <div className="result-meta">
              {dataSource === "precomputed" && (
                <span className="badge-wrap">
                  <span className="badge-precomputed">Precomputed archive data</span>
                  <button className="refresh-live" type="button" onClick={() => analyze(true)} disabled={busy}>
                    Refresh live
                  </button>
                </span>
              )}
              {usedDates.length > 0 && <span className="dates-used">Archive days: {usedDates.join(" · ")}</span>}
              {partialCount > 0 && <span className="skip-notice">{partialCount} day{partialCount === 1 ? "" : "s"} (partial)</span>}
              {skippedCount > 0 && <span className="skip-notice">{skippedCount} day{skippedCount === 1 ? "" : "s"} skipped</span>}
            </div>
          </div>
          {summary && (
            <div className="summary-strip">
              <span className="summary-label">Best window across all sites:</span>
              <strong>{formatWindow(summary.hour)}</strong>
              <span>at</span>
              <strong>{summary.name}</strong>
              <span className="summary-temp">({summary.mean.toFixed(1)}°C)</span>
            </div>
          )}
          {Object.entries(curves).map(([siteId, curve], cardIndex) => {
            const site = sites.find((candidate) => candidate.id === siteId);
            return site ? <SiteCard key={siteId} site={site} curve={curve} cardIndex={cardIndex} /> : null;
          })}
          {Object.keys(curves).length === 0 && (
            <div className="empty-results">No complete hourly evidence was available for these dates.</div>
          )}
        </section>
      )}

      <footer className="mission-footer"><span>Planning guidance, not a safety rating.</span><span>HeatShift / archive analysis</span></footer>
    </main>
  );
}
