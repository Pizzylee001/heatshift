import json, os, time, urllib.error, urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

BASE = "https://api.fortyguard.com"
KEY = os.environ.get("FORTYGUARD_API_KEY", "")
HEADERS = {"api-key": KEY, "Content-Type": "application/json"}

if not KEY:
    raise SystemExit("API key missing. Reload it in this terminal first.")

target = datetime.now(ZoneInfo("America/New_York")) + timedelta(hours=3)
start_date = target.strftime("%Y-%m-%d")
start_time = target.strftime("%H:%M")
print("Requesting forecast hour:", start_date, start_time, "New York time")

payload = {
    "polygon_aoi": {
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
    },
    "date_time": {"start_date": start_date, "start_time": start_time, "filter_type": 1},
    "granularity": 100
}

req = urllib.request.Request(BASE + "/v1/heatmap", data=json.dumps(payload).encode(), headers=HEADERS)
with urllib.request.urlopen(req, timeout=60) as r:
    submit = json.load(r)
activity_id = submit["data"]["activity_id"]
print("Submitted. activity_id:", activity_id)

result = None
for attempt in range(1, 61):
    time.sleep(5)
    try:
        req = urllib.request.Request(BASE + "/v1/status/" + activity_id, headers={"api-key": KEY})
        with urllib.request.urlopen(req, timeout=60) as r:
            body = json.load(r)
    except urllib.error.HTTPError as e:
        print("attempt", attempt, "HTTP", e.code)
        continue
    status = str(body.get("data", {}).get("status", "")).lower()
    print("attempt", attempt, "status:", status)
    if status in ("completed", "succeeded"):
        result = body
        break
    if status in ("failed", "error"):
        with open("forecast_failed.json", "w") as f:
            json.dump(body, f, indent=2)
        print("Task failed. Saved forecast_failed.json")
        break

if result:
    with open("forecast_result.json", "w") as f:
        json.dump(result, f, indent=2)

    def find_key(obj, wanted):
        if isinstance(obj, dict):
            if wanted in obj:
                return obj[wanted]
            for v in obj.values():
                found = find_key(v, wanted)
                if found is not None:
                    return found
        elif isinstance(obj, list):
            for v in obj:
                found = find_key(v, wanted)
                if found is not None:
                    return found
        return None

    def count_tiles(obj):
        n = 0
        if isinstance(obj, dict):
            if "tile_id" in obj:
                return 1
            for v in obj.values():
                n += count_tiles(v)
        elif isinstance(obj, list):
            for v in obj:
                n += count_tiles(v)
        return n

    print("TILES:", count_tiles(result))
    print("STATS:", json.dumps(find_key(result, "temperature_stats")))