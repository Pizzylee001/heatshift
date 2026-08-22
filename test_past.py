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

def run(target, label):
    payload = {
        "polygon_aoi": POLYGON,
        "date_time": {
            "start_date": target.strftime("%Y-%m-%d"),
            "start_time": target.strftime("%H:%M"),
            "filter_type": 1
        },
        "granularity": 100
    }
    req = urllib.request.Request(BASE + "/v1/heatmap", data=json.dumps(payload).encode(), headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as r:
        aid = json.load(r)["data"]["activity_id"]
    print("Testing", label, "->", target.strftime("%Y-%m-%d %H:%M"), "| submitted:", aid)
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
        print("  attempt", attempt, "status:", status)
        if status in ("completed", "succeeded"):
            result = body["data"].get("result") or {}
            md = result.get("map_data") or {}
            sd = result.get("stats_data") or {}
            feats = md.get("features", []) if isinstance(md, dict) else []
            keys = list((feats[0].get("properties") or {}).keys()) if feats else []
            print("RESULT", label, "-> tiles=%d n_cells=%s prop_keys=%s" % (len(feats), sd.get("n_cells"), keys))
            return
        if status in ("failed", "error"):
            print("RESULT", label, "-> FAILED")
            return
    print("RESULT", label, "-> TIMEOUT")

ny = ZoneInfo("America/New_York")
now = datetime.now(ny)
run(now - timedelta(hours=5), "-5h (earlier today)")
run(now - timedelta(hours=29), "-29h (yesterday)")