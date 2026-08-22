"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
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

const HOURS = Array.from({ length: 13 }, (_, index) => index + 6);

function recentDates(): string[] {
  return [10, 11, 12].map((daysAgo) => {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    return date.toISOString().slice(0, 10);
  });
}

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function bandClass(band: TemperatureBand): string {
  return `band-${band.toLowerCase()}`;
}

function SiteCard({
  site,
  curve,
}: {
  site: Site;
  curve: HourCurve[];
}) {
  const [showEvidence, setShowEvidence] = useState(false);
  const ranked = useMemo(() => rankWindows(curve), [curve]);
  const values = new Map(curve.map((entry) => [entry.hour, entry]));

  return (
    <article className="site-card">
      <div className="site-card-heading">
        <div>
          <div className="site-kicker"><span className="site-dot">{site.label}</span> Site {site.label}</div>
          <h2>{site.lat.toFixed(4)}, {site.lng.toFixed(4)}</h2>
        </div>
        <span className="site-sample">{curve.length}/24 hours</span>
      </div>

      <div className="hour-strip" aria-label={`Hourly temperature for site ${site.label}`}> 
        {Array.from({ length: 24 }, (_, hour) => {
          const entry = values.get(hour);
          const band = entry ? classifyBand(entry.mean) : null;
          return (
            <div
              className={`hour-bar ${band ? bandClass(band) : "hour-missing"}`}
              key={hour}
              title={entry ? `${hourLabel(hour)} · ${entry.mean.toFixed(1)}°C` : `${hourLabel(hour)} · no data`}
              style={entry ? { height: `${Math.max(22, Math.min(100, entry.mean * 2.2))}%` } : undefined}
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
  const [phase, setPhase] = useState<"idle" | "loading" | "done">("idle");
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState("");

  const curves = useMemo<HourlyCurve>(() => buildHourlyCurve(dayResults), [dayResults]);

  function addSite(lat: number, lng: number): void {
    if (sites.length >= 3) {
      setToast("max 3 sites");
      window.setTimeout(() => setToast(""), 2200);
      return;
    }
    const label = String.fromCharCode(65 + sites.length);
    setSites((current) => [...current, { id: `site-${label.toLowerCase()}`, label, lat, lng }]);
  }

  function removeSite(id: string): void {
    setSites((current) => current.filter((site) => site.id !== id));
    setDayResults([]);
    setNotice("");
    setError(null);
  }

  async function analyze(): Promise<void> {
    if (sites.length === 0) {
      setToast("Add at least one site");
      window.setTimeout(() => setToast(""), 2200);
      return;
    }
    setPhase("loading");
    setProgress(0);
    setDayResults([]);
    setNotice("");
    setError(null);
    const results: DayResult[] = [];
    const skippedDates = new Set<string>();
    const dates = recentDates();

    for (let index = 0; index < dates.length; index += 1) {
      setProgress(index + 1);
      try {
        const response = await fetch("/api/fortyguard", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sites, date: dates[index], hours: HOURS }),
        });
        if (!response.ok) {
          if ([401, 403, 429, 500].includes(response.status)) {
            setError("The archive is temporarily unavailable. Please try again shortly.");
            continue;
          }
          throw new Error("Day request failed.");
        }
        const payload = (await response.json()) as ApiResponse;
        const hasData = Object.values(payload.sites).some((hours) => Object.keys(hours).length > 0);
        if (!hasData) {
          skippedDates.add(dates[index]);
          continue;
        }
        for (const site of sites) {
          results.push({ siteId: site.id, date: payload.date, hours: payload.sites[site.id] ?? {} });
        }
        setDayResults([...results]);
      } catch {
        skippedDates.add(dates[index]);
      }
    }

    const skipped = skippedDates.size;
    if (skipped > 0) setNotice(`${skipped} day${skipped === 1 ? "" : "s"} skipped`);
    setPhase("done");
  }

  return (
    <main className="mission-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">H</span>
          <div><div className="wordmark">HeatShift</div><div className="tagline">Plan around the heat.</div></div>
        </div>
        <div className="header-status"><span className="status-dot" /> Live archive mode</div>
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
          <HeatMap sites={sites} onAdd={addSite} onRemove={removeSite} disabled={phase === "loading"} />
          <div className="map-footer"><span>OpenStreetMap / FortyGuard archive</span><span>500 m site footprint</span></div>
        </div>
        <aside className="run-panel">
          <div className="panel-label">ANALYSIS RUN</div>
          <h2>Build a three-day heat profile.</h2>
          <p className="run-copy">Compare the most recent fully available archive days across your selected sites.</p>
          <div className="run-specs"><div><span>Archive days</span><strong>−10 / −11 / −12</strong></div><div><span>Resolution</span><strong>Hourly</strong></div><div><span>Coverage</span><strong>06:00–18:00</strong></div></div>
          <button className="analyze-button" type="button" onClick={analyze} disabled={phase === "loading"}>
            {phase === "loading" ? `Fetching day ${progress} of 3…` : phase === "done" ? "Refresh analysis" : "Analyze selected sites"}
            <span aria-hidden="true">→</span>
          </button>
          {toast && <div className="toast" role="status">{toast}</div>}
          {error && <div className="error-text">{error}</div>}
        </aside>
      </section>

      {phase === "loading" && (
        <section className="results-section">
          <div className="results-heading"><div><div className="eyebrow">PROCESSING ARCHIVE</div><h2>Reading measured heat</h2></div><span className="progress-count">{progress} / 3 days</span></div>
          <div className="loading-grid">{sites.map((site) => <div className="loading-card shimmer" key={site.id}><span>Site {site.label}</span><div /><div /></div>)}</div>
        </section>
      )}

      {phase === "done" && (
        <section className="results-section">
          <div className="results-heading"><div><div className="eyebrow">MEASURED EVIDENCE</div><h2>Heat profile by site</h2></div>{notice && <span className="skip-notice">{notice}</span>}</div>
          {Object.entries(curves).map(([siteId, curve]) => {
            const site = sites.find((candidate) => candidate.id === siteId);
            return site ? <SiteCard key={siteId} site={site} curve={curve} /> : null;
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
