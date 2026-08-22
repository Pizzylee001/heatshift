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

def submit(target):
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
        return json.load(r)["data"]["activity_id"]

def wait_result(activity_id):
    for attempt in range(1, 61):
        time.sleep(5)
        try:
            req = urllib.request.Request(BASE + "/v1/status/" + activity_id, headers={"api-key": KEY})
            with urllib.request.urlopen(req, timeout=60) as r:
                body = json.load(r)
        except urllib.error.HTTPError as e:
            print("  attempt", attempt, "HTTP", e.code)
            continue
        status = str(body.get("data", {}).get("status", "")).lower()
        print("  attempt", attempt, "status:", status)
        if status in ("completed", "succeeded"):
            return body["data"].get("result", {})
        if status in ("failed", "error"):
            return {"__failed__": True}
    return None

ny = ZoneInfo("America/New_York")
now = datetime.now(ny)
summary = {}

for hours_ahead in (1, 6):
    target = now + timedelta(hours=hours_ahead)
    label = "+" + str(hours_ahead) + "h"
    print("Testing", label, "->", target.strftime("%Y-%m-%d %H:%M"), "New York time")
    try:
        aid = submit(target)
    except Exception as e:
        print("  SUBMIT ERROR:", e)
        summary[label] = "submit-error"
        continue
    print("  Submitted:", aid)
    result = wait_result(aid)
    if result is None:
        summary[label] = "timeout"
        continue
    if result.get("__failed__"):
        summary[label] = "failed"
        continue
    md = result.get("map_data") or {}
    sd = result.get("stats_data") or {}
    feats = md.get("features", []) if isinstance(md, dict) else []
    temps = []
    prop_keys = []
    if feats:
        prop_keys = list((feats[0].get("properties") or {}).keys())
        for f in feats:
            props = f.get("properties") or {}
            for k in ("average_temperature", "avg_temperature", "temperature", "temp_c", "mean_temperature"):
                v = props.get(k)
                if isinstance(v, (int, float)):
                    temps.append(v)
                    break
    if temps:
        summary[label] = "tiles=%d temp %.2f..%.2f C" % (len(feats), min(temps), max(temps))
    else:
        summary[label] = "tiles=%d n_cells=%s prop_keys=%s" % (len(feats), sd.get("n_cells"), prop_keys)
    with open("offset_%dh.json" % hours_ahead, "w") as f:
        json.dump(result, f, indent=2)

print()
print("SUMMARY:")
for k, v in summary.items():
    print(" ", k, "->", v)