function fmtDate(d) {
  // Business day is Central Time (matches server's BUSINESS_TZ) — not the
  // viewer's local clock or UTC, so "Today" clicked in the evening doesn't
  // roll over to tomorrow's date.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d);
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
    case "yesterday": {
      const y = addDays(start, -1);
      return { start: y, end: y };
    }
    case "week":
    case "lastweek":
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
  loadData();
}

// --- Custom range calendar popup ---
let calendarViewDate = new Date();
let calSelStart = null;
let calSelEnd = null;

function isSameDay(a, b) {
  return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function showCalendarPopup() {
  calendarViewDate = calSelStart ? new Date(calSelStart) : new Date();
  document.getElementById("calendar-popup").classList.remove("hidden");
  renderCalendar();
}

function hideCalendarPopup() {
  document.getElementById("calendar-popup").classList.add("hidden");
}

function renderCalendar() {
  const label = document.getElementById("cal-month-label");
  const grid = document.getElementById("calendar-grid");
  const hint = document.getElementById("calendar-hint");
  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();

  label.textContent = calendarViewDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  if (!calSelStart) hint.textContent = "Pick a start date";
  else if (!calSelEnd) hint.textContent = "Pick an end date";
  else hint.textContent = `${fmtDate(calSelStart)} to ${fmtDate(calSelEnd)}`;

  const firstOfMonth = new Date(year, month, 1);
  const gridStart = addDays(firstOfMonth, -firstOfMonth.getDay());
  const today = new Date();

  grid.innerHTML = "";
  for (let i = 0; i < 42; i++) {
    const day = addDays(gridStart, i);
    const cell = document.createElement("div");
    cell.className = "calendar-day";
    cell.textContent = day.getDate();

    const outside = day.getMonth() !== month;
    if (outside) cell.classList.add("cal-outside");
    if (isSameDay(day, today)) cell.classList.add("cal-today");
    if (isSameDay(day, calSelStart)) cell.classList.add("cal-range-start");
    if (isSameDay(day, calSelEnd)) cell.classList.add("cal-range-end");
    if (calSelStart && calSelEnd && day > calSelStart && day < calSelEnd) cell.classList.add("cal-in-range");

    if (!outside) {
      cell.addEventListener("click", () => selectCalendarDay(day));
    }
    grid.appendChild(cell);
  }
}

function selectCalendarDay(day) {
  if (!calSelStart || calSelEnd) {
    calSelStart = day;
    calSelEnd = null;
  } else {
    calSelEnd = day;
  }

  renderCalendar();

  if (calSelStart && calSelEnd) {
    hideCalendarPopup();
    applyRange("custom", calSelStart, calSelEnd);
  }
}

document.getElementById("cal-prev-month").addEventListener("click", () => {
  calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() - 1, 1);
  renderCalendar();
});

document.getElementById("cal-next-month").addEventListener("click", () => {
  calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() + 1, 1);
  renderCalendar();
});

document.addEventListener("click", (e) => {
  const wrap = document.querySelector(".custom-range-wrap");
  if (wrap && !wrap.contains(e.target)) hideCalendarPopup();
});

document.querySelectorAll(".range-btn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    const range = btn.dataset.range;
    setActiveButton(range);
    if (range === "custom") {
      calSelStart = null;
      calSelEnd = null;
      showCalendarPopup();
      e.stopPropagation();
      return;
    }
    hideCalendarPopup();
    const now = new Date();
    if (range === "today") applyRange("today", now, now);
    if (range === "yesterday") applyRange("yesterday", addDays(now, -1), addDays(now, -1));
    if (range === "week") applyRange("week", startOfWeek(now), now);
    if (range === "lastweek") applyRange("lastweek", addDays(startOfWeek(now), -7), addDays(startOfWeek(now), -1));
    if (range === "month") applyRange("month", startOfMonth(now), now);
    if (range === "quarter") applyRange("quarter", startOfQuarter(now), now);
    if (range === "year") applyRange("year", startOfYear(now), now);
  });
});

document.getElementById("compare-checkbox").addEventListener("change", loadData);

document.getElementById("refresh-data").addEventListener("click", async () => {
  setLoading(true);
  try {
    await fetch("/api/refresh");
  } finally {
    loadData();
  }
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
    ["sales", "leaderboard", "marketing", "cold-outbound", "inbound-calls"].forEach((v) => {
      document.getElementById(`view-${v}`).classList.toggle("hidden", view !== v);
    });
    document
      .getElementById("range-toolbar")
      .classList.toggle("hidden", view !== "sales" && view !== "cold-outbound" && view !== "inbound-calls");
    if (view === "leaderboard") loadLeaderboard();
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

function pctLabel(v) {
  return v !== null && v !== undefined && isFinite(v) ? `${Math.round(v * 10) / 10}%` : "—";
}

function rate(numerator, denominator) {
  return denominator ? (numerator / denominator) * 100 : null;
}

function withPrev(currReps, prevReps) {
  const map = {};
  (prevReps || []).forEach((r) => {
    map[r.name] = r;
  });
  return currReps.map((r) => ({ ...r, _prev: map[r.name] || null }));
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

function renderKPIRow(curr, prev, elId = "kpi-row", { includeTotalClosedRate = true } = {}) {
  const el = document.getElementById(elId);
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

  if (includeTotalClosedRate) {
    items.push({
      label: "Total Closed Rate",
      big: curr.totals.totalClosedRate !== null ? `${curr.totals.totalClosedRate}%` : "—",
      small: `${curr.totals.closedLeads} closed / ${qualified} qualified`,
      delta:
        prev && curr.totals.totalClosedRate !== null && prev.totals.totalClosedRate !== null
          ? deltaHTML(curr.totals.totalClosedRate - prev.totals.totalClosedRate)
          : "",
    });
  }

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
  const order = ["Inbound"];
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

function renderClosedSources(curr, prev) {
  const order = ["Inbound"];
  const items = order.map((name) => ({
    name,
    _prev: prev ? { count: prev.totals.closedSources[name] || 0 } : null,
    count: curr.totals.closedSources[name] || 0,
  }));
  renderBarChart("closed-sources-chart", items, {
    valueOf: (r) => r.count,
    formatValue: (item) => `${item.value} sold`,
    showDelta: true,
  });
}

function rangeForLeaderboard(key) {
  const now = new Date();
  if (key === "week") return { start: startOfWeek(now), end: now };
  if (key === "month") return { start: startOfMonth(now), end: now };
  return { start: now, end: now };
}

function renderLeaderboardList(containerId, reps) {
  const el = document.getElementById(containerId);
  const ranked = reps
    .slice()
    .sort((a, b) => (b.leaderboardCloseRate ?? -1) - (a.leaderboardCloseRate ?? -1));

  if (!ranked.length || !ranked.some((r) => r.closedValue > 0)) {
    el.innerHTML = `<p class="deal-table-empty">No closed contracts yet.</p>`;
    return;
  }

  el.innerHTML = ranked
    .map((rep, i) => {
      const rank = i + 1;
      return `
        <div class="leaderboard-row${rank === 1 ? " leaderboard-first" : ""}">
          <div class="leaderboard-rank">${rank}</div>
          <div class="leaderboard-name">${rep.name}</div>
          <div class="leaderboard-value">${currency(rep.closedValue)}</div>
          <div class="leaderboard-rate">${rep.leaderboardCloseRate !== null ? rep.leaderboardCloseRate + "%" : "—"}</div>
        </div>
      `;
    })
    .join("");
}

async function loadLeaderboardPeriod(key, containerId) {
  const el = document.getElementById(containerId);
  el.innerHTML = `<p class="deal-table-empty">Loading…</p>`;
  try {
    const { start, end } = rangeForLeaderboard(key);
    const data = await fetchJSON(`/api/performance?start=${fmtDate(start)}&end=${fmtDate(end)}`);
    renderLeaderboardList(containerId, data.reps);
  } catch (e) {
    el.innerHTML = `<p class="deal-table-empty">Failed to load: ${e.message}</p>`;
  }
}

function loadLeaderboard() {
  loadLeaderboardPeriod("today", "leaderboard-today-body");
  loadLeaderboardPeriod("week", "leaderboard-week-body");
  loadLeaderboardPeriod("month", "leaderboard-month-body");
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function wrapBarLabel(text, maxChars) {
  if (text.length <= maxChars || !text.includes(" ")) return [text];
  const words = text.split(" ");
  const lines = [];
  let current = "";
  words.forEach((w) => {
    const candidate = current ? `${current} ${w}` : w;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = w;
    } else {
      current = candidate;
    }
  });
  if (current) lines.push(current);
  return lines;
}

// Charts drawn inside a hidden tab measure 0px wide and render shrunken, so
// redraw each chart whenever its container's width actually changes.
// Small width jitter (e.g. a scrollbar appearing as charts redraw) is ignored
// so redraws can't feed back into each other, and resize redraws skip the
// bar grow-in animation.
const barChartState = new Map();
const barChartObserver = new ResizeObserver((entries) => {
  requestAnimationFrame(() => {
    for (const entry of entries) {
      const state = barChartState.get(entry.target.id);
      const w = Math.round(entry.target.clientWidth);
      if (state && w > 0 && Math.abs(w - state.width) > 24) {
        renderBarChart(entry.target.id, state.reps, state.opts, { animate: false });
      }
    }
  });
});

function renderBarChart(containerId, reps, opts, { animate = true } = {}) {
  const el = document.getElementById(containerId);
  el.innerHTML = "";
  if (!barChartState.has(containerId)) barChartObserver.observe(el);
  barChartState.set(containerId, { reps, opts, width: Math.round(el.clientWidth) });

  const items = reps
    .map((r) => ({
      rep: r,
      label: r.name,
      value: opts.valueOf(r) || 0,
      previousValue: r._prev ? opts.valueOf(r._prev) || 0 : null,
    }))
    .sort((a, b) => b.value - a.value);

  const width = Math.max(320, Math.round(el.clientWidth) || 640);
  const padding = { top: opts.showDelta ? 58 : 36, right: 20, bottom: 40, left: 20 };
  const chartWidth = width - padding.left - padding.right;
  const barGap = 32;
  const barWidth = (chartWidth - barGap * (items.length - 1)) / items.length;

  const maxCharsPerLine = Math.max(6, Math.floor(barWidth / 8));
  const labelLines = items.map((item) => wrapBarLabel(item.label, maxCharsPerLine));
  const maxLabelLines = Math.max(1, ...labelLines.map((lines) => lines.length));
  padding.bottom += (maxLabelLines - 1) * 16;

  const height = 300 + (maxLabelLines - 1) * 16;
  const chartHeight = height - padding.top - padding.bottom;
  const baselineY = padding.top + chartHeight;

  const rawMax = Math.max(1, ...items.map((i) => i.value), ...items.map((i) => i.previousValue || 0), opts.referenceLineAt || 0);
  const maxValue = rawMax * 1.15;

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height, class: "bar-chart" });

  const defs = svgEl("defs", {});
  const gradient = svgEl("linearGradient", { id: "bar-gradient", x1: 0, y1: 0, x2: 0, y2: 1 });
  gradient.appendChild(svgEl("stop", { offset: "0%", "stop-color": "#4cc247" }));
  gradient.appendChild(svgEl("stop", { offset: "100%", "stop-color": "#005136" }));
  defs.appendChild(gradient);
  svg.appendChild(defs);

  [0.25, 0.5, 0.75].forEach((frac) => {
    const gy = baselineY - frac * chartHeight;
    svg.appendChild(svgEl("line", { x1: padding.left, x2: width - padding.right, y1: gy, y2: gy, class: "bar-grid-line" }));
  });

  items.forEach((item, i) => {
    const x = padding.left + i * (barWidth + barGap);
    const group = svgEl("g", { class: "bar-group" });

    if (item.previousValue !== null && item.value > 0) {
      const ghostHeight = (item.previousValue / maxValue) * chartHeight;
      group.appendChild(
        svgEl("rect", { x, y: baselineY - ghostHeight, width: barWidth, height: Math.max(ghostHeight, 0), rx: 6, class: "bar-ghost-rect" })
      );
    }

    const barHeight = (item.value / maxValue) * chartHeight;
    const y = baselineY - barHeight;
    const bar = svgEl("rect", { x, y, width: barWidth, height: Math.max(barHeight, 0), rx: 8, class: "bar-fill-rect" });
    if (animate) bar.style.animationDelay = `${i * 70}ms`;
    else bar.style.animation = "none";
    group.appendChild(bar);

    // Sit labels above whichever is taller — this period's bar or last period's outline.
    const ghostTop = item.previousValue !== null && item.value > 0 ? baselineY - (item.previousValue / maxValue) * chartHeight : baselineY;
    const labelY = Math.min(y, ghostTop);
    const valueLabel = svgEl("text", { x: x + barWidth / 2, y: labelY - 10, "text-anchor": "middle", class: "bar-value-label" });
    valueLabel.textContent = opts.formatValue(item);
    group.appendChild(valueLabel);

    if (opts.showDelta && item.previousValue !== null && item.previousValue !== 0) {
      const change = ((item.value - item.previousValue) / item.previousValue) * 100;
      const rounded = Math.round(change * 10) / 10;
      const cls = rounded > 0 ? "bar-delta-up" : rounded < 0 ? "bar-delta-down" : "bar-delta-flat";
      const arrow = rounded > 0 ? "▲" : rounded < 0 ? "▼" : "▬";
      const deltaLabel = svgEl("text", {
        x: x + barWidth / 2,
        y: labelY - 32,
        "text-anchor": "middle",
        class: `bar-delta-label ${cls}`,
      });
      deltaLabel.textContent = `${arrow} ${Math.abs(rounded)}% vs prev`;
      group.appendChild(deltaLabel);
    }

    const nameLabel = svgEl("text", { x: x + barWidth / 2, y: baselineY + 22, "text-anchor": "middle", class: "bar-name-label" });
    const lines = labelLines[i];
    if (lines.length === 1) {
      nameLabel.textContent = lines[0];
    } else {
      lines.forEach((line, lineIdx) => {
        const tspan = svgEl("tspan", { x: x + barWidth / 2, dy: lineIdx === 0 ? 0 : 16 });
        tspan.textContent = line;
        nameLabel.appendChild(tspan);
      });
    }
    group.appendChild(nameLabel);

    if (opts.onClick) {
      const hitRect = svgEl("rect", {
        x,
        y: padding.top,
        width: barWidth,
        height: chartHeight,
        fill: "transparent",
        class: "bar-hit-rect",
      });
      hitRect.addEventListener("click", () => opts.onClick(item.rep));
      group.appendChild(hitRect);
    }
    svg.appendChild(group);
  });

  svg.appendChild(svgEl("line", { x1: padding.left, x2: width - padding.right, y1: baselineY, y2: baselineY, class: "bar-axis-line" }));

  if (items.some((item) => item.previousValue !== null && item.value > 0)) {
    const legendX = width - padding.right - 104;
    svg.appendChild(svgEl("rect", { x: legendX, y: 4, width: 12, height: 12, rx: 3, class: "bar-ghost-rect" }));
    const legendLabel = svgEl("text", { x: legendX + 18, y: 14, class: "bar-ref-label" });
    legendLabel.textContent = "Previous period";
    svg.appendChild(legendLabel);
  }

  if (opts.referenceLineAt) {
    const refY = baselineY - (opts.referenceLineAt / maxValue) * chartHeight;
    svg.appendChild(svgEl("line", { x1: padding.left, x2: width - padding.right, y1: refY, y2: refY, class: "bar-ref-line" }));
    const refLabel = svgEl("text", { x: width - padding.right, y: refY - 4, "text-anchor": "end", class: "bar-ref-label" });
    refLabel.textContent = opts.referenceLabel || "";
    svg.appendChild(refLabel);
  }

  el.appendChild(svg);
}

async function fetchJSON(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function formatDealDate(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function closeRepDealsModal() {
  document.getElementById("rep-deals-modal").classList.add("hidden");
}

async function openRepDealsModal(repName, endpoint = "/api/rep-deals", titleSuffix = "Sold Contracts") {
  const modal = document.getElementById("rep-deals-modal");
  const body = document.getElementById("rep-deals-body");
  document.getElementById("rep-deals-title").textContent = `${repName} — ${titleSuffix}`;
  body.innerHTML = `<p class="deal-table-empty">Loading…</p>`;
  modal.classList.remove("hidden");

  try {
    const start = fmtDate(currentRange.start);
    const end = fmtDate(currentRange.end);
    const data = await fetchJSON(`${endpoint}?rep=${encodeURIComponent(repName)}&start=${start}&end=${end}`);
    if (!data.deals.length) {
      body.innerHTML = `<p class="deal-table-empty">No closed contracts in this date range.</p>`;
      return;
    }
    const rows = data.deals
      .map(
        (d) => `<tr>
          <td>${d.name}</td>
          <td>${currency(d.value)}</td>
          <td>${formatDealDate(d.closedDate)}</td>
        </tr>`
      )
      .join("");
    body.innerHTML = `
      <table class="deal-table">
        <thead><tr><th>Lead</th><th>Contract Value</th><th>Closed Date</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } catch (e) {
    body.innerHTML = `<p class="deal-table-empty">Failed to load: ${e.message}</p>`;
  }
}

async function openQualifiedLeadsModal(repName) {
  const modal = document.getElementById("rep-deals-modal");
  const body = document.getElementById("rep-deals-body");
  document.getElementById("rep-deals-title").textContent = `${repName} — Qualified Leads`;
  body.innerHTML = `<p class="deal-table-empty">Loading…</p>`;
  modal.classList.remove("hidden");

  try {
    const start = fmtDate(currentRange.start);
    const end = fmtDate(currentRange.end);
    const data = await fetchJSON(
      `/api/inbound-qualified-leads?rep=${encodeURIComponent(repName)}&start=${start}&end=${end}`
    );
    if (!data.leads.length) {
      body.innerHTML = `<p class="deal-table-empty">No qualified leads in this date range.</p>`;
      return;
    }
    const rows = data.leads
      .map(
        (l) => `<tr>
          <td>${l.name}</td>
          <td>${formatDealDate(l.dateAdded)}</td>
        </tr>`
      )
      .join("");
    body.innerHTML = `
      <table class="deal-table">
        <thead><tr><th>Lead</th><th>Date Added</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } catch (e) {
    body.innerHTML = `<p class="deal-table-empty">Failed to load: ${e.message}</p>`;
  }
}

document.getElementById("rep-deals-close").addEventListener("click", closeRepDealsModal);
document.getElementById("rep-deals-modal").addEventListener("click", (e) => {
  if (e.target.id === "rep-deals-modal") closeRepDealsModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeRepDealsModal();
    hideCalendarPopup();
  }
});

function renderColdOutbound(data) {
  const counts = data.callerCounts.counts || {};
  const callers = Object.keys(counts).map((name) => ({ name, count: counts[name] }));
  const totalCalls = callers.reduce((sum, c) => sum + c.count, 0);

  const kpiEl = document.getElementById("cold-outbound-kpi-row");
  kpiEl.innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">Total Contacts Called</div>
      <div class="kpi-value">${totalCalls}</div>
    </div>
  `;

  renderBarChart("cold-outbound-chart", callers, {
    valueOf: (r) => r.count,
    formatValue: (item) => `${item.value}`,
  });

  const dispoCounts = data.dispositionCounts.counts || {};
  const dispositions = Object.keys(dispoCounts).map((name) => ({ name, count: dispoCounts[name] }));
  renderBarChart("cold-outbound-disposition-chart", dispositions, {
    valueOf: (r) => r.count,
    formatValue: (item) => `${item.value}`,
  });
}

async function loadColdOutbound(start, end) {
  const banner = document.getElementById("cold-outbound-error-banner");
  banner.classList.add("hidden");
  banner.textContent = "";
  try {
    const data = await fetchJSON(`/api/cold-outbound?start=${start}&end=${end}`);
    renderColdOutbound(data);
  } catch (e) {
    banner.classList.remove("hidden");
    banner.textContent = `Cold Outbound data: ${e.message}`;
  }
}

async function loadInboundCalls(start, end) {
  const banner = document.getElementById("inbound-calls-error-banner");
  banner.classList.add("hidden");
  banner.textContent = "";
  try {
    const data = await fetchJSON(`/api/inbound-calls?start=${start}&end=${end}`);
    renderKPIRow(data, null, "inbound-kpi-row", { includeTotalClosedRate: false });
    renderBarChart("inbound-sold-chart", data.reps, {
      valueOf: (r) => r.closedCount,
      formatValue: (item) => `${item.value} sold`,
      onClick: (rep) => openRepDealsModal(rep.name, "/api/inbound-rep-deals"),
    });
    renderBarChart("inbound-qualified-chart", data.reps, {
      valueOf: (r) => r.qualifiedLeads,
      formatValue: (item) => `${item.value}`,
      onClick: (rep) => openQualifiedLeadsModal(rep.name),
    });
    renderBarChart("inbound-close-rate-chart", data.reps, {
      valueOf: (r) => r.qualifiedCloseRate || 0,
      formatValue: (item) => (item.rep.qualifiedCloseRate !== null ? `${item.rep.qualifiedCloseRate}%` : "—"),
      referenceLineAt: 100,
      referenceLabel: "100%",
    });
  } catch (e) {
    banner.classList.remove("hidden");
    banner.textContent = `Inbound Calls data: ${e.message}`;
  }
}

let loadToken = 0;

function setLoading(isLoading) {
  document.getElementById("loading-indicator").classList.toggle("hidden", !isLoading);
  document.querySelectorAll(".range-btn, #compare-checkbox").forEach((el) => {
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
  loadColdOutbound(start, end); // fire independently — same reasoning
  loadInboundCalls(start, end); // fire independently — same reasoning

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
    renderClosedSources(curr, prev);

    const repsWithPrev = withPrev(curr.reps, prev ? prev.reps : null);

    renderBarChart("sold-services-chart", repsWithPrev, {
      valueOf: (r) => r.closedCount,
      formatValue: (item) => `${item.value} sold`,
      showDelta: true,
      onClick: (rep) => openRepDealsModal(rep.name),
    });

    renderBarChart("sales-share", repsWithPrev, {
      valueOf: (r) => r.closedValue,
      formatValue: (item) => `${currency(item.value)} (${item.rep.pctOfTotal}%)`,
      showDelta: true,
      onClick: (rep) => openRepDealsModal(rep.name),
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

  } catch (e) {
    if (token === loadToken) showError(`Performance data: ${e.message}`);
  } finally {
    if (token === loadToken) setLoading(false);
  }
}

// default to today on load
setActiveButton("today");
applyRange("today", new Date(), new Date());
loadLeaderboard();
