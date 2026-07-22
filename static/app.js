function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}

function startOfWeek(d) {
  const day = d.getDay(); // 0 = Sunday
  const diff = (day === 0 ? -6 : 1) - day; // back to Monday
  return addDays(d, diff);
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function startOfQuarter(d) {
  const qMonth = Math.floor(d.getMonth() / 3) * 3;
  return new Date(d.getFullYear(), qMonth, 1);
}

function startOfYear(d) {
  return new Date(d.getFullYear(), 0, 1);
}

function previousPeriodFor(key, start, end) {
  switch (key) {
    case "today": {
      const y = addDays(start, -1);
      return { start: y, end: y };
    }
    case "week":
      return { start: addDays(start, -7), end: addDays(end, -7) };
    case "month": {
      const prevMonthStart = new Date(start.getFullYear(), start.getMonth() - 1, 1);
      const dayOfMonth = end.getDate();
      const daysInPrevMonth = new Date(prevMonthStart.getFullYear(), prevMonthStart.getMonth() + 1, 0).getDate();
      const prevEnd = new Date(prevMonthStart.getFullYear(), prevMonthStart.getMonth(), Math.min(dayOfMonth, daysInPrevMonth));
      return { start: prevMonthStart, end: prevEnd };
    }
    case "quarter": {
      const daysIn = daysBetween(start, end);
      const prevQuarterStart = new Date(start.getFullYear(), start.getMonth() - 3, 1);
      return { start: prevQuarterStart, end: addDays(prevQuarterStart, daysIn) };
    }
    case "year": {
      const daysIn = daysBetween(start, end);
      const prevYearStart = new Date(start.getFullYear() - 1, 0, 1);
      return { start: prevYearStart, end: addDays(prevYearStart, daysIn) };
    }
    case "custom":
    default: {
      const lengthDays = daysBetween(start, end) + 1;
      const prevEnd = addDays(start, -1);
      const prevStart = addDays(prevEnd, -(lengthDays - 1));
      return { start: prevStart, end: prevEnd };
    }
  }
}

function currency(n) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

let currentRange = { start: null, end: null };
let currentRangeKey = "week";

function setActiveButton(range) {
  document.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("active"));
  const btn = document.querySelector(`.range-btn[data-range="${range}"]`);
  if (btn) btn.classList.add("active");
}

function applyRange(rangeKey, start, end) {
  currentRangeKey = rangeKey;
  currentRange = { start, end };
  document.getElementById("range-label").textContent = `${fmtDate(start)} to ${fmtDate(end)}`;
  loadData();
}

document.querySelectorAll(".range-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const range = btn.dataset.range;
    setActiveButton(range);
    const customInputs = document.getElementById("custom-inputs");
    if (range === "custom") {
      customInputs.classList.remove("hidden");
      return;
    }
    customInputs.classList.add("hidden");
    const now = new Date();
    if (range === "today") applyRange("today", now, now);
    if (range === "week") applyRange("week", startOfWeek(now), now);
    if (range === "month") applyRange("month", startOfMonth(now), now);
    if (range === "quarter") applyRange("quarter", startOfQuarter(now), now);
    if (range === "year") applyRange("year", startOfYear(now), now);
  });
});

document.getElementById("apply-custom").addEventListener("click", () => {
  const start = document.getElementById("start-date").value;
  const end = document.getElementById("end-date").value;
  if (!start || !end) return;
  applyRange("custom", new Date(start), new Date(end));
});

document.getElementById("compare-checkbox").addEventListener("change", loadData);

document.getElementById("refresh-data").addEventListener("click", async () => {
  await fetch("/api/refresh");
  loadData();
});

function powerDialerCloseRate(d) {
  return d.called ? Math.round((d.closed / d.called) * 1000) / 10 : null;
}

async function loadPowerDialer(start, end) {
  const el = document.getElementById("power-dialer-row");
  const compareEnabled = document.getElementById("compare-checkbox").checked;
  try {
    let curr;
    let prev = null;
    if (compareEnabled) {
      const prevRange = previousPeriodFor(currentRangeKey, currentRange.start, currentRange.end);
      const [currRes, prevRes] = await Promise.all([
        fetchJSON(`/api/power-dialer?start=${start}&end=${end}`),
        fetchJSON(`/api/power-dialer?start=${fmtDate(prevRange.start)}&end=${fmtDate(prevRange.end)}`),
      ]);
      curr = currRes;
      prev = prevRes;
    } else {
      curr = await fetchJSON(`/api/power-dialer?start=${start}&end=${end}`);
    }

    const missingNote =
      curr.missingDays && curr.missingDays.length
        ? `<div class="kpi-small">${curr.missingDays.length} day(s) in range not tracked yet</div>`
        : "";
    const closeRate = powerDialerCloseRate(curr);
    const prevCloseRate = prev ? powerDialerCloseRate(prev) : null;

    const calledDelta = prev ? deltaHTML(pctChange(curr.called, prev.called)) : "";
    const closedDelta = prev ? deltaHTML(pctChange(curr.closed, prev.closed)) : "";
    const contractDelta = prev ? deltaHTML(pctChange(curr.contractValue, prev.contractValue)) : "";
    const closeRateDelta = prev && closeRate !== null && prevCloseRate !== null ? deltaHTML(closeRate - prevCloseRate) : "";

    el.innerHTML = `
      <div class="kpi-card">
        <div class="kpi-label">Leads Called</div>
        <div class="kpi-value">${curr.called}</div>
        ${calledDelta ? `<div class="kpi-delta">${calledDelta} vs previous period</div>` : ""}
        ${missingNote}
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Leads Closed</div>
        <div class="kpi-value">${curr.closed}</div>
        ${closedDelta ? `<div class="kpi-delta">${closedDelta} vs previous period</div>` : ""}
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Contract Amount</div>
        <div class="kpi-value">${currency(curr.contractValue)}</div>
        ${contractDelta ? `<div class="kpi-delta">${contractDelta} vs previous period</div>` : ""}
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Closed Rate</div>
        <div class="kpi-value">${closeRate !== null ? closeRate + "%" : "—"}</div>
        ${closeRateDelta ? `<div class="kpi-delta">${closeRateDelta} vs previous period</div>` : ""}
      </div>
    `;
  } catch (e) {
    el.innerHTML = `<div class="kpi-card"><div class="kpi-label">Power Dialer</div><div class="kpi-small">${e.message}</div></div>`;
  }
}

document.querySelectorAll(".view-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".view-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const view = tab.dataset.view;
    document.getElementById("view-sales").classList.toggle("hidden", view !== "sales");
    document.getElementById("view-marketing").classList.toggle("hidden", view !== "marketing");
  });
});

function showError(msg) {
  const banner = document.getElementById("error-banner");
  if (!msg) {
    banner.classList.add("hidden");
    banner.textContent = "";
    return;
  }
  banner.classList.remove("hidden");
  banner.textContent = msg;
}

function pctChange(curr, prev) {
  if (prev === null || prev === undefined || prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

function deltaHTML(change) {
  if (change === null || change === undefined || !isFinite(change)) return "";
  const rounded = Math.round(change * 10) / 10;
  const cls = rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
  const arrow = rounded > 0 ? "▲" : rounded < 0 ? "▼" : "▬";
  return `<span class="delta ${cls}">${arrow} ${Math.abs(rounded)}%</span>`;
}

function withPrev(currReps, prevReps) {
  const map = {};
  (prevReps || []).forEach((r) => {
    map[r.name] = r;
  });
  return currReps.map((r) => ({ ...r, _prev: map[r.name] || null }));
}

function pctLabel(v) {
  return v !== null && v !== undefined && isFinite(v) ? `${Math.round(v * 10) / 10}%` : "—";
}

function rate(numerator, denominator) {
  return denominator ? (numerator / denominator) * 100 : null;
}

function renderTopKPIRow(curr, prev) {
  const el = document.getElementById("kpi-row-top");
  el.innerHTML = "";
  const items = [
    {
      label: "Total Sales",
      big: `${curr.totals.closedCount}`,
      small: "",
      delta: prev ? deltaHTML(pctChange(curr.totals.closedCount, prev.totals.closedCount)) : "",
    },
    {
      label: "Contract Value",
      big: currency(curr.totals.closedValue),
      small: "",
      delta: prev ? deltaHTML(pctChange(curr.totals.closedValue, prev.totals.closedValue)) : "",
    },
  ];
  items.forEach((item) => {
    const card = document.createElement("div");
    card.className = "kpi-card";
    card.innerHTML = `
      <div class="kpi-label">${item.label}</div>
      <div class="kpi-value">${item.big}</div>
      ${item.delta ? `<div class="kpi-delta">${item.delta} vs previous period</div>` : ""}
    `;
    el.appendChild(card);
  });
}

function renderKPIRow(curr, prev) {
  const el = document.getElementById("kpi-row");
  el.innerHTML = "";

  const leads = curr.totals.leads;
  const qualified = curr.totals.qualifiedLeads;
  const sales = curr.totals.closedCount;
  const qualRate = rate(qualified, leads);
  const saleRate = rate(sales, leads);
  const closeRate = curr.totals.closeRate;

  const prevQualRate = prev ? rate(prev.totals.qualifiedLeads, prev.totals.leads) : null;
  const prevSaleRate = prev ? rate(prev.totals.closedCount, prev.totals.leads) : null;

  const items = [
    {
      label: "Leads",
      big: `${leads}`,
      small: "",
      delta: prev ? deltaHTML(pctChange(leads, prev.totals.leads)) : "",
    },
    {
      label: "Qualified Leads",
      big: pctLabel(qualRate),
      small: `${qualified} qualified`,
      delta: prev && qualRate !== null && prevQualRate !== null ? deltaHTML(qualRate - prevQualRate) : "",
    },
    {
      label: "Sales",
      big: pctLabel(saleRate),
      small: `${sales} sales`,
      delta: prev && saleRate !== null && prevSaleRate !== null ? deltaHTML(saleRate - prevSaleRate) : "",
    },
    {
      label: "Contract Value",
      big: currency(curr.totals.closedValue),
      small: "",
      delta: prev ? deltaHTML(pctChange(curr.totals.closedValue, prev.totals.closedValue)) : "",
    },
    {
      label: "Close Rate",
      big: closeRate !== null ? `${closeRate}%` : "—",
      small: `${sales} sales / ${qualified} qualified`,
      delta:
        prev && closeRate !== null && prev.totals.closeRate !== null
          ? deltaHTML(closeRate - prev.totals.closeRate)
          : "",
    },
  ];

  items.forEach((item) => {
    const card = document.createElement("div");
    card.className = "kpi-card";
    card.innerHTML = `
      <div class="kpi-label">${item.label}</div>
      <div class="kpi-value">${item.big}</div>
      ${item.small ? `<div class="kpi-small">${item.small}</div>` : ""}
      ${item.delta ? `<div class="kpi-delta">${item.delta} vs previous period</div>` : ""}
    `;
    el.appendChild(card);
  });
}

function renderSources(curr, prev) {
  const order = ["Meta", "Inbound", "Website", "Other"];
  const items = order.map((name) => ({
    name,
    _prev: prev ? { count: prev.totals.sources[name] || 0 } : null,
    count: curr.totals.sources[name] || 0,
  }));
  renderBarChart("sources-chart", items, {
    valueOf: (r) => r.count,
    formatValue: (item) => `${item.value}`,
  });
}

function renderSales(curr, prev) {
  const container = document.getElementById("sales-cards");
  container.innerHTML = "";
  const prevByName = {};
  (prev ? prev.reps : []).forEach((r) => {
    prevByName[r.name] = r;
  });
  curr.reps.forEach((rep) => {
    const p = prevByName[rep.name];
    const delta = p ? deltaHTML(pctChange(rep.closedValue, p.closedValue)) : "";
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="name">${rep.name}</div>
      <div class="value">${currency(rep.closedValue)}</div>
      <div class="count">${rep.closedCount} closed-won${delta ? ` · ${delta} vs prev` : ""}</div>
      ${rep.missingClosedDate ? `<div class="note">${rep.missingClosedDate} deal(s) missing a Closed Date — counted by created date instead</div>` : ""}
    `;
    container.appendChild(card);
  });
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function renderBarChart(containerId, reps, opts) {
  const el = document.getElementById(containerId);
  el.innerHTML = "";

  const items = reps
    .map((r) => ({
      rep: r,
      label: r.name,
      value: opts.valueOf(r) || 0,
      previousValue: r._prev ? opts.valueOf(r._prev) || 0 : null,
    }))
    .sort((a, b) => b.value - a.value);

  const width = 640;
  const height = 300;
  const padding = { top: 36, right: 20, bottom: 40, left: 20 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const barGap = 32;
  const barWidth = (chartWidth - barGap * (items.length - 1)) / items.length;
  const baselineY = padding.top + chartHeight;

  const rawMax = Math.max(1, ...items.map((i) => i.value), ...items.map((i) => i.previousValue || 0), opts.referenceLineAt || 0);
  const maxValue = rawMax * 1.15;

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height, class: "bar-chart" });

  items.forEach((item, i) => {
    const x = padding.left + i * (barWidth + barGap);

    if (item.previousValue !== null) {
      const ghostHeight = (item.previousValue / maxValue) * chartHeight;
      svg.appendChild(
        svgEl("rect", { x, y: baselineY - ghostHeight, width: barWidth, height: Math.max(ghostHeight, 0), rx: 6, class: "bar-ghost-rect" })
      );
    }

    const barHeight = (item.value / maxValue) * chartHeight;
    const y = baselineY - barHeight;
    svg.appendChild(svgEl("rect", { x, y, width: barWidth, height: Math.max(barHeight, 0), rx: 6, class: "bar-fill-rect" }));

    const valueLabel = svgEl("text", { x: x + barWidth / 2, y: y - 10, "text-anchor": "middle", class: "bar-value-label" });
    valueLabel.textContent = opts.formatValue(item);
    svg.appendChild(valueLabel);

    const nameLabel = svgEl("text", { x: x + barWidth / 2, y: baselineY + 22, "text-anchor": "middle", class: "bar-name-label" });
    nameLabel.textContent = item.label;
    svg.appendChild(nameLabel);
  });

  svg.appendChild(svgEl("line", { x1: padding.left, x2: width - padding.right, y1: baselineY, y2: baselineY, class: "bar-axis-line" }));

  if (opts.referenceLineAt) {
    const refY = baselineY - (opts.referenceLineAt / maxValue) * chartHeight;
    svg.appendChild(svgEl("line", { x1: padding.left, x2: width - padding.right, y1: refY, y2: refY, class: "bar-ref-line" }));
    const refLabel = svgEl("text", { x: width - padding.right, y: refY - 4, "text-anchor": "end", class: "bar-ref-label" });
    refLabel.textContent = opts.referenceLabel || "";
    svg.appendChild(refLabel);
  }

  el.appendChild(svg);
}

function renderPerfTable(curr, prev) {
  const el = document.getElementById("perf-table-wrap");
  const prevByName = {};
  (prev ? prev.reps : []).forEach((r) => {
    prevByName[r.name] = r;
  });
  const rows = curr.reps
    .slice()
    .sort((a, b) => b.closedValue - a.closedValue)
    .map((rep) => {
      const p = prevByName[rep.name];
      const delta = p ? deltaHTML(pctChange(rep.closedValue, p.closedValue)) : "—";
      return `<tr>
        <td>${rep.name}</td>
        <td>${currency(rep.closedValue)}</td>
        <td>${rep.pctOfTotal}%</td>
        <td>${rep.qualifiedLeads}</td>
        <td>${rep.closeRate !== null ? rep.closeRate + "%" : "—"}</td>
        <td>${delta}</td>
      </tr>`;
    })
    .join("");

  const totalDelta = prev ? deltaHTML(pctChange(curr.totals.closedValue, prev.totals.closedValue)) : "—";

  el.innerHTML = `
    <table class="perf-table">
      <thead>
        <tr><th>Rep</th><th>Closed $</th><th>% Share</th><th>Qualified Leads</th><th>Close Rate</th><th>Δ vs prev</th></tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td>Total</td>
          <td>${currency(curr.totals.closedValue)}</td>
          <td>100%</td>
          <td>${curr.totals.qualifiedLeads}</td>
          <td>${curr.totals.closeRate !== null ? curr.totals.closeRate + "%" : "—"}</td>
          <td>${totalDelta}</td>
        </tr>
      </tfoot>
    </table>
  `;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

let loadToken = 0;

function setLoading(isLoading) {
  document.getElementById("loading-indicator").classList.toggle("hidden", !isLoading);
  document.querySelectorAll(".range-btn, #apply-custom, #compare-checkbox").forEach((el) => {
    el.disabled = isLoading;
  });
}

async function loadData() {
  if (!currentRange.start) return;
  const token = ++loadToken;
  showError(null);
  setLoading(true);
  const start = fmtDate(currentRange.start);
  const end = fmtDate(currentRange.end);
  const compareEnabled = document.getElementById("compare-checkbox").checked;

  loadPowerDialer(start, end); // fire independently — can be slow on a cold cache, shouldn't block the rest

  try {
    let curr;
    let prev = null;
    if (compareEnabled) {
      const prevRange = previousPeriodFor(currentRangeKey, currentRange.start, currentRange.end);
      const combined = await fetchJSON(
        `/api/performance-compare?start=${start}&end=${end}&prevStart=${fmtDate(prevRange.start)}&prevEnd=${fmtDate(prevRange.end)}`
      );
      curr = combined.current;
      prev = combined.previous;
    } else {
      curr = await fetchJSON(`/api/performance?start=${start}&end=${end}`);
    }

    if (token !== loadToken) return; // superseded by a newer request

    renderTopKPIRow(curr, prev);
    renderKPIRow(curr, prev);
    renderSources(curr, prev);
    renderSales(curr, prev);

    const repsWithPrev = withPrev(curr.reps, prev ? prev.reps : null);

    renderBarChart("sold-services-chart", repsWithPrev, {
      valueOf: (r) => r.closedCount,
      formatValue: (item) => `${item.value} sold`,
    });

    renderBarChart("sales-share", repsWithPrev, {
      valueOf: (r) => r.closedValue,
      formatValue: (item) => `${currency(item.value)} (${item.rep.pctOfTotal}%)`,
    });

    renderBarChart("qualified-leads-chart", repsWithPrev, {
      valueOf: (r) => r.qualifiedLeads,
      formatValue: (item) => `${item.value}`,
    });

    renderBarChart("close-rate-chart", repsWithPrev, {
      valueOf: (r) => r.closeRate || 0,
      formatValue: (item) => (item.rep.closeRate !== null ? `${item.rep.closeRate}%` : "—"),
      referenceLineAt: 100,
      referenceLabel: "100%",
    });

    renderPerfTable(curr, prev);
  } catch (e) {
    if (token === loadToken) showError(`Performance data: ${e.message}`);
  } finally {
    if (token === loadToken) setLoading(false);
  }
}

// default to today on load
setActiveButton("today");
applyRange("today", new Date(), new Date());
