import json, os, time, urllib.error, urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

BASE = "https://api.fortyguard.com"
KEY = os.environ.get("FORTYGUARD_API_KEY", "")
HEADERS = {"api-key": KEY, "Content-Type": "application/json"}

if not KEY:
    raise SystemExit("API key missing. Reload it first.")

POLYGON = {
    "type": "FeatureCollection",
    "features": [{
        "type": "Feature",
        "properties": {},
        "geometry": {
            "type": "Polygon",
            "coordinates": [[
                [-74.0170, 40.7050],
                [-74.0030, 40.7050],
                [-74.0030, 40.7180],
                [-74.0170, 40.7180],
                [-74.0170, 40.7050]
            ]]
        }
    }]
}

def run(target):
    label = target.strftime("%Y-%m-%d")
    payload = {
        "polygon_aoi": POLYGON,
        "date_time": {
            "start_date": target.strftime("%Y-%m-%d"),
            "start_time": "14:00",
            "filter_type": 1
        },
        "granularity": 100
    }
    req = urllib.request.Request(BASE + "/v1/heatmap", data=json.dumps(payload).encode(), headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            aid = json.load(r)["data"]["activity_id"]
    except Exception as e:
        print(label, "-> SUBMIT ERROR:", e)
        return
    print("Testing", label, "| submitted:", aid)
    for attempt in range(1, 61):
        time.sleep(5)
        try:
            req = urllib.request.Request(BASE + "/v1/status/" + aid, headers={"api-key": KEY})
            with urllib.request.urlopen(req, timeout=60) as r:
                body = json.load(r)
        except urllib.error.HTTPError as e:
            print("  attempt", attempt, "HTTP", e.code)
            continue
        status = str(body.get("data", {}).get("status", "")).lower()
        if status in ("completed", "succeeded"):
            result = body["data"].get("result") or {}
            md = result.get("map_data") or {}
            sd = result.get("stats_data") or {}
            feats = md.get("features", []) if isinstance(md, dict) else []
            stats = None
            ts = result.get("stats_data") or {}
            inner = ts.get("temperature_stats") if isinstance(ts, dict) else None
            print("RESULT", label, "-> tiles=%d n_cells=%s stats=%s" % (
                len(feats), sd.get("n_cells"), json.dumps(inner) if inner else "none"))
            return
        if status in ("failed", "error"):
            print("RESULT", label, "-> FAILED")
            return
    print("RESULT", label, "-> TIMEOUT")

ny = ZoneInfo("America/New_York")
now = datetime.now(ny)
for days_back in (7, 30, 90, 180, 365):
    run(now - timedelta(days=days_back))