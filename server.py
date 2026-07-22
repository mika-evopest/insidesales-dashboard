import json
import os
import threading
import time
import urllib.parse
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")
ENV_PATH = os.path.join(HERE, ".env")
POWER_DIALER_HISTORY_PATH = os.path.join(HERE, "power_dialer_history.json")

API_BASE = "https://services.leadconnectorhq.com"
API_VERSION = "2021-07-28"

BUSINESS_TZ = ZoneInfo("America/Chicago")

REPS = [
    {"name": "Jay Reyes", "pipelineId": "T1XpjVLy3lDfLVWY7f9D", "closedWonStageId": "47bfd32a-1e99-46af-9a47-4723a9af3e36"},
    {"name": "Sergio Anaya", "pipelineId": "4QyVIDo2jPdiPQUflkLd", "closedWonStageId": "e05e0bd7-c78f-4906-a16b-edcaa56fc8e8"},
    {"name": "Daniel Barba", "pipelineId": "I7YdjQ5jlYF21SEl5B5g", "closedWonStageId": "342ebbe5-29be-46d7-aa19-4d486e841233"},
]

CLOSED_DATE_FIELD_ID = "y2AEQ5nyUzxhLLLnG6bx"
QUALIFICATION_STATUS_FIELD_ID = "SYrPZw5WGIbpPYuiDaBx"
FIRST_TOUCH_QUALIFIER_FIELD_ID = "bs8z28NC8AFOaTofqXMz"
SALES_REP_FIELD_ID = "LWLa9vQ7KLP3UuV5MMzc"
POWER_DIALER_ATTEMPT_FIELD_ID = "vNjCVqQ3NiMGBQ4mHehJ"
LEAD_STAGE_FIELD_ID = "dt44fTl1UU9rY77EyAvb"

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
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 4:
                time.sleep(2 * (attempt + 1))  # backoff: 2s, 4s, 6s, 8s
                last_error = e
                continue
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


def in_range(d, start, end):
    return d is not None and start <= d <= end


def local_date(dt):
    # For real timestamps (dateAdded, createdAt) — convert to the business's
    # timezone to get the calendar date it actually happened on locally.
    if dt is None:
        return None
    return dt.astimezone(BUSINESS_TZ).date() if dt.tzinfo else dt.date()


def utc_date_only(dt):
    # For date-only fields (like the opportunity "Closed Date" custom field),
    # HighLevel encodes the chosen calendar date as midnight UTC — that's a
    # pure date value with no real time-of-day, so it must NOT be converted
    # to another timezone (doing so would shift it back a day).
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).date() if dt.tzinfo else dt.date()


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


def paginate_contacts(max_pages, should_stop=None):
    results = []
    start_after = None
    start_after_id = None
    for _ in range(max_pages):
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
        if should_stop and should_stop(page):
            break
        meta = data.get("meta", {})
        next_after = meta.get("startAfter")
        next_after_id = meta.get("startAfterId")
        if len(page) < 100 or not next_after_id:
            break
        start_after, start_after_id = next_after, next_after_id
    return results


def fetch_all_contacts(range_start):
    # Contacts come back newest-first (dateAdded desc), so we can stop as soon
    # as a page's oldest contact falls before the requested range.
    def should_stop(page):
        oldest_in_page = parse_date(page[-1].get("dateAdded"))
        return bool(oldest_in_page and oldest_in_page.astimezone(BUSINESS_TZ).date() < range_start)

    return paginate_contacts(max_pages=100, should_stop=should_stop)  # safety cap: 100 pages x 100 = 10000


def fetch_all_contacts_unbounded():
    # Full scan — needed for fields like "Last Outbound Call" that can be set
    # on any contact regardless of when it was originally added as a lead, so
    # the dateAdded-based early exit above doesn't apply.
    return paginate_contacts(max_pages=200)  # safety cap: 200 pages x 100 = 20000


DATA_CACHE_TTL_SECONDS = 600
_contacts_cache = []
_opps_cache = {}
_all_contacts_cache = {"fetchedAt": None, "contacts": []}


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


def get_all_contacts_cached():
    now = time.monotonic()
    fetched_at = _all_contacts_cache["fetchedAt"]
    if fetched_at is not None and now - fetched_at < DATA_CACHE_TTL_SECONDS:
        return _all_contacts_cache["contacts"]
    contacts = fetch_all_contacts_unbounded()
    _all_contacts_cache["fetchedAt"] = now
    _all_contacts_cache["contacts"] = contacts
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


def is_test_opportunity(opp):
    return "test" in (opp.get("name") or "").lower()


def rep_sales(rep, start, end):
    opps = get_opportunities_for(rep["pipelineId"], rep["closedWonStageId"])
    count = 0
    value = 0.0
    missing_closed_date = 0
    for opp in opps:
        if is_test_opportunity(opp):
            continue
        closed_dt = parse_date(custom_field_value(opp.get("customFields"), CLOSED_DATE_FIELD_ID))
        missing = closed_dt is None
        if missing:
            closed = local_date(parse_date(opp.get("createdAt") or opp.get("dateAdded")))
        else:
            closed = utc_date_only(closed_dt)
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
        added = local_date(parse_date(c.get("dateAdded")))
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
    return sum(1 for c in contacts if in_range(local_date(parse_date(c.get("dateAdded"))), start, end))


def count_qualified_leads(contacts, start, end):
    count = 0
    for c in contacts:
        added = local_date(parse_date(c.get("dateAdded")))
        if not in_range(added, start, end):
            continue
        status = custom_field_value(c.get("customFields"), QUALIFICATION_STATUS_FIELD_ID)
        if status == "Qualified":
            count += 1
    return count


def categorize_source(source):
    s = (source or "").lower()
    if "meta" in s:
        return "Meta"
    if "inbound" in s:
        return "Inbound"
    if "website" in s or "contact us form" in s:
        return "Website"
    return "Other"


def count_sources(contacts, start, end):
    counts = {"Meta": 0, "Inbound": 0, "Website": 0, "Other": 0}
    for c in contacts:
        added = local_date(parse_date(c.get("dateAdded")))
        if not in_range(added, start, end):
            continue
        counts[categorize_source(c.get("source"))] += 1
    return counts


def compute_period_metrics(start, end, contacts):
    with ThreadPoolExecutor(max_workers=len(REPS)) as pool:
        sales_list = list(pool.map(lambda rep: rep_sales(rep, start, end), REPS))

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
            "sources": count_sources(contacts, start, end),
        },
    }


def handle_performance(start, end):
    contacts = get_contacts_for(start)
    return compute_period_metrics(start, end, contacts)


def handle_performance_compare(start, end, prev_start, prev_end):
    # Fetch contacts once, covering whichever period starts earlier, so both
    # periods are computed from a single shared dataset instead of two
    # independent (and possibly racing/duplicated) fetches.
    earliest_start = min(start, prev_start)
    contacts = get_contacts_for(earliest_start)
    return {
        "current": compute_period_metrics(start, end, contacts),
        "previous": compute_period_metrics(prev_start, prev_end, contacts),
    }


def compute_live_power_dialer():
    # GHL's "Power Dialer Attempt Today" only reflects the current day and gets
    # reset/overwritten over time, so this can only ever answer "today" — past
    # days must come from our own saved daily snapshots instead.
    contacts = get_all_contacts_cached()

    with ThreadPoolExecutor(max_workers=len(REPS)) as pool:
        opps_by_rep = list(pool.map(lambda rep: get_opportunities_for(rep["pipelineId"], rep["closedWonStageId"]), REPS))
    opp_value_by_contact = {}
    for opps in opps_by_rep:
        for opp in opps:
            if is_test_opportunity(opp):
                continue
            contact_id = opp.get("contactId")
            if contact_id:
                opp_value_by_contact[contact_id] = opp_value_by_contact.get(contact_id, 0) + float(opp.get("monetaryValue") or 0)

    called = 0
    closed = 0
    contract_value = 0.0
    for c in contacts:
        attempts = custom_field_value(c.get("customFields"), POWER_DIALER_ATTEMPT_FIELD_ID)
        try:
            attempts_num = float(attempts) if attempts is not None else 0
        except (TypeError, ValueError):
            attempts_num = 0
        if attempts_num >= 1:
            called += 1
            lead_stage = custom_field_value(c.get("customFields"), LEAD_STAGE_FIELD_ID)
            if lead_stage == "Closed/Won":
                closed += 1
                contract_value += opp_value_by_contact.get(c.get("id"), 0)
    return {"called": called, "closed": closed, "contractValue": round(contract_value, 2)}


_history_lock = threading.Lock()


def load_power_dialer_history():
    with _history_lock:
        if not os.path.exists(POWER_DIALER_HISTORY_PATH):
            return {}
        with open(POWER_DIALER_HISTORY_PATH) as f:
            return json.load(f)


def save_power_dialer_snapshot(date_key, called, closed, contract_value):
    with _history_lock:
        history = {}
        if os.path.exists(POWER_DIALER_HISTORY_PATH):
            with open(POWER_DIALER_HISTORY_PATH) as f:
                history = json.load(f)
        history[date_key] = {"called": called, "closed": closed, "contractValue": contract_value}
        with open(POWER_DIALER_HISTORY_PATH, "w") as f:
            json.dump(history, f, indent=2)


def snapshot_power_dialer_today():
    live = compute_live_power_dialer()
    today_key = datetime.now(BUSINESS_TZ).date().isoformat()
    save_power_dialer_snapshot(today_key, live["called"], live["closed"], live["contractValue"])
    return live


def handle_power_dialer(start, end):
    today = datetime.now(BUSINESS_TZ).date()
    history = load_power_dialer_history()
    total_called = 0
    total_closed = 0
    total_contract_value = 0.0
    missing_days = []
    d = start
    while d <= end:
        if d == today:
            live = snapshot_power_dialer_today()
            total_called += live["called"]
            total_closed += live["closed"]
            total_contract_value += live["contractValue"]
        else:
            entry = history.get(d.isoformat())
            if entry:
                total_called += entry["called"]
                total_closed += entry["closed"]
                total_contract_value += entry.get("contractValue", 0)
            else:
                missing_days.append(d.isoformat())
        d += timedelta(days=1)
    return {
        "called": total_called,
        "closed": total_closed,
        "contractValue": round(total_contract_value, 2),
        "missingDays": missing_days,
    }



def tally_field(contacts, field_id, start, end):
    counts = {}
    unset = 0
    total_in_range = 0
    for c in contacts:
        added = local_date(parse_date(c.get("dateAdded")))
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


CACHE_TTL_SECONDS = 600
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


def clear_all_caches():
    _cache.clear()
    _contacts_cache.clear()
    _opps_cache.clear()
    _all_contacts_cache["fetchedAt"] = None
    _all_contacts_cache["contacts"] = []


def warm_cache():
    # Pre-fetches the data behind the default view (this month) so the first
    # real request after a cold start doesn't pay the full fetch cost.
    def _run():
        try:
            today = datetime.now(BUSINESS_TZ).date()
            month_start = today.replace(day=1)
            get_contacts_for(month_start)
            with ThreadPoolExecutor(max_workers=len(REPS)) as pool:
                list(pool.map(lambda rep: get_opportunities_for(rep["pipelineId"], rep["closedWonStageId"]), REPS))
        except Exception:
            pass  # best-effort warm-up; a real request will retry and surface any real error

    def _run_full_scan():
        try:
            get_all_contacts_cached()
        except Exception:
            pass

    threading.Thread(target=_run, daemon=True).start()
    threading.Thread(target=_run_full_scan, daemon=True).start()


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

        if parsed.path == "/api/performance-compare":
            try:
                start = datetime.fromisoformat(qs["start"][0]).date()
                end = datetime.fromisoformat(qs["end"][0]).date()
                prev_start = datetime.fromisoformat(qs["prevStart"][0]).date()
                prev_end = datetime.fromisoformat(qs["prevEnd"][0]).date()
            except (KeyError, ValueError):
                self.send_json({"error": "start, end, prevStart, prevEnd query params (YYYY-MM-DD) are required"}, 400)
                return
            try:
                self.send_json(
                    cached(
                        ("performance-compare", start, end, prev_start, prev_end),
                        lambda: handle_performance_compare(start, end, prev_start, prev_end),
                    )
                )
            except ConfigError as e:
                self.send_json({"error": str(e)}, 400)
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
            return

        if parsed.path == "/api/power-dialer":
            try:
                start = datetime.fromisoformat(qs["start"][0]).date()
                end = datetime.fromisoformat(qs["end"][0]).date()
            except (KeyError, ValueError):
                self.send_json({"error": "start and end query params (YYYY-MM-DD) are required"}, 400)
                return
            try:
                self.send_json(cached(("power-dialer", start, end), lambda: handle_power_dialer(start, end)))
            except ConfigError as e:
                self.send_json({"error": str(e)}, 400)
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
            return

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

        if parsed.path == "/api/refresh":
            clear_all_caches()
            self.send_json({"status": "refreshed"})
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
    else:
        warm_cache()
    server.serve_forever()
