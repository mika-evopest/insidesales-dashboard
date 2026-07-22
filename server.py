import json
import os
import time
import urllib.parse
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")
ENV_PATH = os.path.join(HERE, ".env")

API_BASE = "https://services.leadconnectorhq.com"
API_VERSION = "2021-07-28"

REPS = [
    {"name": "Jay Reyes", "pipelineId": "T1XpjVLy3lDfLVWY7f9D", "closedWonStageId": "47bfd32a-1e99-46af-9a47-4723a9af3e36"},
    {"name": "Sergio Anaya", "pipelineId": "4QyVIDo2jPdiPQUflkLd", "closedWonStageId": "e05e0bd7-c78f-4906-a16b-edcaa56fc8e8"},
    {"name": "Daniel Barba", "pipelineId": "I7YdjQ5jlYF21SEl5B5g", "closedWonStageId": "342ebbe5-29be-46d7-aa19-4d486e841233"},
]

CLOSED_DATE_FIELD_ID = "y2AEQ5nyUzxhLLLnG6bx"
QUALIFICATION_STATUS_FIELD_ID = "SYrPZw5WGIbpPYuiDaBx"
FIRST_TOUCH_QUALIFIER_FIELD_ID = "bs8z28NC8AFOaTofqXMz"
SALES_REP_FIELD_ID = "LWLa9vQ7KLP3UuV5MMzc"

DEFAULT_LOCATION_ID = "TqGBaQdHphlOYfdWZo9s"


def load_dotenv_into_environ():
    # Local dev convenience only. On a host like Render, real env vars are set
    # via the dashboard and take precedence over anything in a .env file.
    if not os.path.exists(ENV_PATH):
        return
    with open(ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)


load_dotenv_into_environ()
API_KEY = os.environ.get("HIGHLEVEL_API_KEY", "")
LOCATION_ID = os.environ.get("HIGHLEVEL_LOCATION_ID", DEFAULT_LOCATION_ID)


class ConfigError(Exception):
    pass


def hl_request(path, params=None, method="GET"):
    if not API_KEY:
        raise ConfigError("HIGHLEVEL_API_KEY is not set. Add it to .env and restart the server.")
    params = dict(params or {})
    url = f"{API_BASE}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Bearer {API_KEY}")
    req.add_header("Version", API_VERSION)
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", "evo-dashboard/1.0")
    last_error = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HighLevel API error {e.code} on {path}: {body}")
        except (TimeoutError, OSError) as e:
            last_error = e
    raise RuntimeError(f"HighLevel API request to {path} timed out after 3 attempts: {last_error}")


def parse_date(value):
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / 1000, tz=timezone.utc)
    try:
        value = value.replace("Z", "+00:00")
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def custom_field_value(custom_fields, field_id):
    for cf in custom_fields or []:
        if cf.get("id") == field_id:
            for key in ("value", "fieldValue", "fieldValueDate", "fieldValueString", "fieldValueArray"):
                if cf.get(key) is not None:
                    return cf.get(key)
    return None


def in_range(dt, start, end):
    if dt is None:
        return False
    d = dt.astimezone(timezone.utc).date() if dt.tzinfo else dt.date()
    return start <= d <= end


def fetch_all_opportunities(pipeline_id, stage_id):
    results = []
    start_after = None
    start_after_id = None
    for _ in range(20):  # safety cap: 20 pages x 100 = 2000 opportunities per rep
        params = {
            "location_id": LOCATION_ID,
            "pipeline_id": pipeline_id,
            "pipeline_stage_id": stage_id,
            "limit": 100,
        }
        if start_after:
            params["startAfter"] = start_after
        if start_after_id:
            params["startAfterId"] = start_after_id
        data = hl_request("/opportunities/search", params)
        page = data.get("opportunities", data.get("data", []))
        results.extend(page)
        meta = data.get("meta", {})
        next_after = meta.get("startAfter")
        next_after_id = meta.get("startAfterId")
        if not page or len(page) < 100 or not next_after_id:
            break
        start_after, start_after_id = next_after, next_after_id
    return results


def fetch_all_contacts(range_start):
    # Contacts come back newest-first (dateAdded desc), so we can stop as soon
    # as a page's oldest contact falls before the requested range.
    results = []
    start_after = None
    start_after_id = None
    for _ in range(100):  # safety cap: 100 pages x 100 = 10000 contacts
        params = {"locationId": LOCATION_ID, "limit": 100}
        if start_after:
            params["startAfter"] = start_after
        if start_after_id:
            params["startAfterId"] = start_after_id
        data = hl_request("/contacts/", params)
        page = data.get("contacts", data.get("data", []))
        results.extend(page)
        if not page:
            break
        oldest_in_page = parse_date(page[-1].get("dateAdded"))
        if oldest_in_page and oldest_in_page.date() < range_start:
            break
        meta = data.get("meta", {})
        next_after = meta.get("startAfter")
        next_after_id = meta.get("startAfterId")
        if len(page) < 100 or not next_after_id:
            break
        start_after, start_after_id = next_after, next_after_id
    return results


DATA_CACHE_TTL_SECONDS = 180
_contacts_cache = []
_opps_cache = {}


def get_contacts_for(range_start):
    now = time.monotonic()
    _contacts_cache[:] = [c for c in _contacts_cache if now - c["fetchedAt"] < DATA_CACHE_TTL_SECONDS]
    covering = [c for c in _contacts_cache if c["start"] <= range_start]
    if covering:
        best = max(covering, key=lambda c: c["start"])  # tightest covering fetch
        return best["contacts"]
    contacts = fetch_all_contacts(range_start)
    _contacts_cache.append({"start": range_start, "fetchedAt": now, "contacts": contacts})
    return contacts


def get_opportunities_for(pipeline_id, stage_id):
    now = time.monotonic()
    key = (pipeline_id, stage_id)
    hit = _opps_cache.get(key)
    if hit and now - hit["fetchedAt"] < DATA_CACHE_TTL_SECONDS:
        return hit["opps"]
    opps = fetch_all_opportunities(pipeline_id, stage_id)
    _opps_cache[key] = {"fetchedAt": now, "opps": opps}
    return opps


def rep_sales(rep, start, end):
    opps = get_opportunities_for(rep["pipelineId"], rep["closedWonStageId"])
    count = 0
    value = 0.0
    missing_closed_date = 0
    for opp in opps:
        closed = parse_date(custom_field_value(opp.get("customFields"), CLOSED_DATE_FIELD_ID))
        missing = closed is None
        if missing:
            closed = parse_date(opp.get("createdAt") or opp.get("dateAdded"))
        if in_range(closed, start, end):
            count += 1
            value += float(opp.get("monetaryValue") or 0)
            if missing:
                missing_closed_date += 1
    return {
        "name": rep["name"],
        "count": count,
        "value": round(value, 2),
        "missingClosedDate": missing_closed_date,
    }


def handle_sales(start, end):
    with ThreadPoolExecutor(max_workers=len(REPS)) as pool:
        reps_out = list(pool.map(lambda rep: rep_sales(rep, start, end), REPS))
    return {
        "reps": reps_out,
        "totals": {
            "count": sum(r["count"] for r in reps_out),
            "value": round(sum(r["value"] for r in reps_out), 2),
        },
    }


def rep_qualified_leads_count(contacts, rep_name, start, end):
    count = 0
    for c in contacts:
        added = parse_date(c.get("dateAdded"))
        if not in_range(added, start, end):
            continue
        status = custom_field_value(c.get("customFields"), QUALIFICATION_STATUS_FIELD_ID)
        if status != "Qualified":
            continue
        reps = custom_field_value(c.get("customFields"), SALES_REP_FIELD_ID)
        reps = reps if isinstance(reps, list) else ([reps] if reps else [])
        if rep_name in reps:
            count += 1
    return count


def count_leads(contacts, start, end):
    return sum(1 for c in contacts if in_range(parse_date(c.get("dateAdded")), start, end))


def count_qualified_leads(contacts, start, end):
    count = 0
    for c in contacts:
        added = parse_date(c.get("dateAdded"))
        if not in_range(added, start, end):
            continue
        status = custom_field_value(c.get("customFields"), QUALIFICATION_STATUS_FIELD_ID)
        if status == "Qualified":
            count += 1
    return count


def handle_performance(start, end):
    with ThreadPoolExecutor(max_workers=len(REPS)) as pool:
        sales_list = list(pool.map(lambda rep: rep_sales(rep, start, end), REPS))
    contacts = get_contacts_for(start)

    total_value = sum(r["value"] for r in sales_list)
    reps_out = []
    for rep, sales in zip(REPS, sales_list):
        qualified = rep_qualified_leads_count(contacts, rep["name"], start, end)
        close_rate = round(sales["count"] / qualified * 100, 1) if qualified else None
        pct_of_total = round(sales["value"] / total_value * 100, 1) if total_value else 0.0
        reps_out.append({
            "name": rep["name"],
            "closedValue": sales["value"],
            "closedCount": sales["count"],
            "missingClosedDate": sales["missingClosedDate"],
            "qualifiedLeads": qualified,
            "closeRate": close_rate,
            "pctOfTotal": pct_of_total,
        })

    total_closed_count = sum(r["closedCount"] for r in reps_out)
    total_leads = count_leads(contacts, start, end)
    total_qualified = count_qualified_leads(contacts, start, end)
    overall_close_rate = round(total_closed_count / total_qualified * 100, 1) if total_qualified else None

    return {
        "reps": reps_out,
        "totals": {
            "closedValue": round(total_value, 2),
            "closedCount": total_closed_count,
            "leads": total_leads,
            "qualifiedLeads": total_qualified,
            "closeRate": overall_close_rate,
        },
    }


def tally_field(contacts, field_id, start, end):
    counts = {}
    unset = 0
    total_in_range = 0
    for c in contacts:
        added = parse_date(c.get("dateAdded"))
        if not in_range(added, start, end):
            continue
        total_in_range += 1
        value = custom_field_value(c.get("customFields"), field_id)
        if value is None or value == "" or value == []:
            unset += 1
            continue
        values = value if isinstance(value, list) else [value]
        for v in values:
            counts[v] = counts.get(v, 0) + 1
    return {"counts": counts, "unset": unset, "totalInRange": total_in_range}


def handle_qualification(start, end):
    contacts = get_contacts_for(start)
    qualification_status = tally_field(contacts, QUALIFICATION_STATUS_FIELD_ID, start, end)
    first_touch = tally_field(contacts, FIRST_TOUCH_QUALIFIER_FIELD_ID, start, end)
    return {
        "qualificationStatus": qualification_status,
        "firstTouchQualifier": first_touch,
    }


CACHE_TTL_SECONDS = 180
_cache = {}


def cached(key_parts, compute_fn):
    key = tuple(key_parts)
    now = time.monotonic()
    hit = _cache.get(key)
    if hit and now - hit[0] < CACHE_TTL_SECONDS:
        return hit[1]
    result = compute_fn()
    _cache[key] = (now, result)
    return result


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, content_type):
        try:
            with open(path, "rb") as f:
                body = f.read()
        except FileNotFoundError:
            self.send_json({"error": "not found"}, 404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)

        if parsed.path in ("/api/sales", "/api/qualification", "/api/performance"):
            try:
                start = datetime.fromisoformat(qs["start"][0]).date()
                end = datetime.fromisoformat(qs["end"][0]).date()
            except (KeyError, ValueError):
                self.send_json({"error": "start and end query params (YYYY-MM-DD) are required"}, 400)
                return
            try:
                if parsed.path == "/api/sales":
                    self.send_json(cached(("sales", start, end), lambda: handle_sales(start, end)))
                elif parsed.path == "/api/qualification":
                    self.send_json(cached(("qualification", start, end), lambda: handle_qualification(start, end)))
                else:
                    self.send_json(cached(("performance", start, end), lambda: handle_performance(start, end)))
            except ConfigError as e:
                self.send_json({"error": str(e)}, 400)
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
            return

        if parsed.path == "/" or parsed.path == "/index.html":
            self.send_file(os.path.join(STATIC_DIR, "index.html"), "text/html")
            return
        if parsed.path == "/app.js":
            self.send_file(os.path.join(STATIC_DIR, "app.js"), "application/javascript")
            return
        if parsed.path == "/style.css":
            self.send_file(os.path.join(STATIC_DIR, "style.css"), "text/css")
            return

        self.send_json({"error": "not found"}, 404)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8787"))
    host = os.environ.get("HOST", "0.0.0.0")
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"evo-dashboard running on {host}:{port}")
    if not API_KEY:
        print("WARNING: HIGHLEVEL_API_KEY is not set — API calls will fail until it's added as an env var.")
    server.serve_forever()
