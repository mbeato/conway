var B = location.origin, ri = null;

function gt() { return sessionStorage.getItem("t"); }
function st(t) { sessionStorage.setItem("t", t); }
function ct() { sessionStorage.removeItem("t"); }

async function login() {
  var inp = document.getElementById("token-input");
  var err = document.getElementById("login-error");
  var tok = inp.value.trim();
  if (!tok) { err.textContent = "Token required"; return; }
  try {
    var res = await fetch(B + "/api/stats", { headers: { Authorization: "Bearer " + tok } });
    if (res.status === 401) { err.textContent = "Invalid token"; return; }
    if (!res.ok) { err.textContent = "Error " + res.status; return; }
    st(tok); inp.value = ""; err.textContent = "";
    show(); render(await res.json());
  } catch(e) { err.textContent = "Network error"; }
}

document.getElementById("token-input").addEventListener("keydown", function(e) { if (e.key === "Enter") login(); });
document.getElementById("login-btn").addEventListener("click", login);
document.getElementById("logout-btn").addEventListener("click", logout);

function logout() {
  ct(); stopR();
  document.getElementById("login").classList.remove("hidden");
  document.getElementById("dashboard").classList.remove("active");
}

function show() {
  document.getElementById("login").classList.add("hidden");
  document.getElementById("dashboard").classList.add("active");
  startR();
}

function startR() { stopR(); if (document.getElementById("auto-refresh").checked) ri = setInterval(load, 10000); }
function stopR() { if (ri) { clearInterval(ri); ri = null; } }
document.getElementById("auto-refresh").addEventListener("change", function() {
  if (this.checked) startR(); else stopR();
});

async function load() {
  var tok = gt(); if (!tok) return;
  try {
    var res = await fetch(B + "/api/stats", { headers: { Authorization: "Bearer " + tok } });
    if (res.status === 401) { logout(); return; }
    if (!res.ok) return;
    render(await res.json());
  } catch(e) {}
}

function fmt$(v) { return "$" + Number(v || 0).toFixed(4); }
function fmtN(v) { return Number(v || 0).toLocaleString(); }
function fmtPct(v) { return (Number(v || 0) * 100).toFixed(1) + "%"; }
function fmtTime(iso) {
  if (!iso) return "--";
  var normalized = iso.replace(" ", "T");
  if (!/[Z+\-]\d*$/.test(normalized)) normalized += "Z";
  var d = new Date(normalized);
  if (isNaN(d)) return iso;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function esc(s) { var d = document.createElement("div"); d.textContent = s || ""; return d.innerHTML; }

// --- SVG ---
function sparkline(el, data, color) {
  if (!data || !data.length) { el.innerHTML = ""; return; }
  var w = 80, h = 28, max = Math.max.apply(null, data.concat([0.001]));
  var pts = data.map(function(v, i) {
    return [(i / Math.max(data.length - 1, 1)) * w, h - (v / max) * (h - 2) - 1];
  });
  var d = pts.map(function(p, i) { return (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1); }).join("");
  el.innerHTML = '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
    '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function barChart(el, labels, vals) {
  if (!vals || !vals.length) { el.innerHTML = '<div class="empty-state">No data</div>'; return; }
  var w = 700, h = 120, max = Math.max.apply(null, vals.concat([1]));
  var bw = Math.max(2, w / vals.length - 1.5);
  var svg = '';

  for (var g = 0; g <= 3; g++) {
    var gy = (h / 3) * g;
    svg += '<line x1="0" y1="' + gy.toFixed(1) + '" x2="' + w + '" y2="' + gy.toFixed(1) + '" stroke="#1a1a1a" stroke-width="1"/>';
  }

  for (var i = 0; i < vals.length; i++) {
    var bh = (vals[i] / max) * (h - 4);
    var x = (i / vals.length) * w;
    var y = h - bh;
    svg += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="1" fill="#333"/>';
  }

  var step = Math.max(1, Math.floor(vals.length / 6));
  for (var j = 0; j < labels.length; j += step) {
    var lx = (j / vals.length) * w + bw / 2;
    svg += '<text x="' + lx.toFixed(1) + '" y="' + (h + 14) + '" fill="#444" font-size="10" font-family="Inter,sans-serif" text-anchor="middle">' + esc(labels[j]) + '</text>';
  }

  el.innerHTML = '<svg viewBox="0 0 ' + w + ' ' + (h + 18) + '" preserveAspectRatio="none">' + svg + '</svg>';
}

function breakdown(el, items) {
  if (!items || !items.length) { el.innerHTML = '<div class="empty-state">No revenue data</div>'; return; }
  var colors = ["#ededed", "#999", "#666", "#555", "#444", "#333"];
  el.innerHTML = items.slice(0, 8).map(function(item, i) {
    return '<div class="breakdown-item">' +
      '<div class="breakdown-dot" style="background:' + colors[i % colors.length] + '"></div>' +
      '<div class="breakdown-name">' + esc(item.api_name) + '</div>' +
      '<div class="breakdown-val">' + fmt$(item.total_usd) + '</div></div>';
  }).join("");
}

function render(data) {
  var upd = function(id, v) { document.getElementById(id).textContent = v; };
  upd("rev-7d", fmt$(data.revenue_7d));
  upd("rev-30d", fmt$(data.revenue_30d));
  upd("active-apis", data.apis ? data.apis.length : 0);
  upd("total-requests", fmtN(data.total_requests_7d));

  if (data.wallet) {
    document.getElementById("wallet").textContent = data.wallet.substring(0, 6) + "..." + data.wallet.slice(-4);
    document.getElementById("wallet").title = data.wallet;
  }
  document.getElementById("last-updated").textContent = new Date().toLocaleTimeString();

  if (data.charts) {
    sparkline(document.getElementById("spark-rev"), (data.charts.daily_revenue_7d || []).map(function(d) { return d.total_usd; }), "#3ddc84");
    sparkline(document.getElementById("spark-rev-30"), (data.charts.daily_revenue_30d || []).map(function(d) { return d.total_usd; }), "#3ddc84");
    sparkline(document.getElementById("spark-req"), (data.charts.daily_requests_7d || []).map(function(d) { return d.total; }), "#ededed");

    var hourly = data.charts.hourly_requests_24h || [];
    barChart(
      document.getElementById("chart-hourly"),
      hourly.map(function(h) { var p = h.hour.split(" "); return p[1] || h.hour; }),
      hourly.map(function(h) { return h.total; })
    );
  }

  breakdown(document.getElementById("api-breakdown"), data.revenue_by_api);

  var ab = document.getElementById("apis-table");
  if (!data.apis || !data.apis.length) {
    ab.innerHTML = '<tr><td colspan="4" class="empty-state">No APIs</td></tr>';
  } else {
    ab.innerHTML = data.apis.map(function(a) {
      var errColor = a.error_rate_7d && a.error_rate_7d.rate > 0.05 ? ' class="mono red"' : ' class="mono dim"';
      return '<tr>' +
        '<td class="primary"><a href="https://' + esc(a.subdomain) + '.apimesh.xyz" target="_blank">' + esc(a.name) + '</a></td>' +
        '<td class="mono">' + fmtN(a.requests_7d) + '</td>' +
        '<td' + errColor + '>' + fmtPct(a.error_rate_7d ? a.error_rate_7d.rate : 0) + '</td>' +
        '<td class="mono green">' + fmt$(a.revenue_7d) + '</td></tr>';
    }).join("");
  }

  var rb = document.getElementById("requests-table");
  if (!data.recent_requests || !data.recent_requests.length) {
    rb.innerHTML = '<tr><td colspan="6" class="empty-state">No events</td></tr>';
  } else {
    rb.innerHTML = data.recent_requests.slice(0, 15).map(function(r) {
      var sc = r.status_code;
      var scClass = sc >= 500 ? "mono red" : sc >= 400 ? "mono" : "mono green";
      return '<tr>' +
        '<td class="mono dim">' + fmtTime(r.created_at) + '</td>' +
        '<td class="primary">' + esc(r.api_name) + '</td>' +
        '<td class="mono dim">' + esc(r.method) + ' ' + esc(r.endpoint) + '</td>' +
        '<td class="' + scClass + '">' + (Number.isFinite(sc) ? sc : "--") + '</td>' +
        '<td class="mono dim">' + (Number.isFinite(r.response_time_ms) ? r.response_time_ms.toFixed(0) + "ms" : "--") + '</td>' +
        '<td>' + (r.paid ? '<span class="badge badge-paid">paid</span>' : '<span class="badge badge-free">free</span>') + '</td></tr>';
    }).join("");
  }
}

if (gt()) { show(); load(); }

// --- Tabs ---
document.querySelectorAll(".tab").forEach(function(tab) {
  tab.addEventListener("click", function() {
    document.querySelectorAll(".tab").forEach(function(t) { t.classList.remove("active"); });
    document.querySelectorAll(".tab-content").forEach(function(t) { t.classList.remove("active"); });
    tab.classList.add("active");
    document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
    if (tab.dataset.tab === "caps") loadCaps();
  });
});

// --- Audit Log ---
var auditOffset = 0, auditLimit = 50;

function fmtWallet(w) {
  if (!w) return '<span class="dim">--</span>';
  return '<span title="' + esc(w) + '">' + esc(w.substring(0, 6) + "..." + w.slice(-4)) + '</span>';
}
function fmtTx(h) {
  if (!h) return '<span class="dim">--</span>';
  return '<a href="https://basescan.org/tx/' + esc(h) + '" target="_blank" style="color:#52a8ff">' + esc(h.substring(0, 8) + "...") + '</a>';
}

async function loadAudit(reset) {
  var tok = gt(); if (!tok) return;
  if (reset) auditOffset = 0;
  var wallet = document.getElementById("audit-wallet").value.trim();
  var api = document.getElementById("audit-api").value;
  var params = "limit=" + auditLimit + "&offset=" + auditOffset;
  if (wallet) params += "&wallet=" + encodeURIComponent(wallet);
  if (api) params += "&api=" + encodeURIComponent(api);
  try {
    var res = await fetch(B + "/api/audit-log?" + params, { headers: { Authorization: "Bearer " + tok } });
    if (!res.ok) return;
    var data = await res.json();
    renderAudit(data);
  } catch(e) {}
}

function renderAudit(data) {
  var tb = document.getElementById("audit-table");
  if (!data.rows || !data.rows.length) {
    tb.innerHTML = '<tr><td colspan="7" class="empty-state">No records found</td></tr>';
    document.getElementById("audit-pagination").style.display = "none";
    return;
  }
  tb.innerHTML = data.rows.map(function(r) {
    var sc = r.status_code;
    var scClass = sc >= 500 ? "mono red" : sc >= 400 ? "mono" : "mono green";
    return '<tr>' +
      '<td class="mono dim">' + fmtTime(r.created_at) + '</td>' +
      '<td class="mono">' + fmtWallet(r.payer_wallet) + '</td>' +
      '<td class="primary">' + esc(r.api_name) + '</td>' +
      '<td class="mono dim">' + esc(r.method) + ' ' + esc(r.endpoint) + '</td>' +
      '<td class="' + scClass + '">' + (Number.isFinite(sc) ? sc : esc(String(sc))) + '</td>' +
      '<td class="mono">' + (r.amount_usd > 0 ? '<span class="green">' + fmt$(r.amount_usd) + '</span>' : '<span class="dim">free</span>') + '</td>' +
      '<td class="mono">' + fmtTx(r.tx_hash) + '</td></tr>';
  }).join("");

  var pg = document.getElementById("audit-pagination");
  pg.style.display = "flex";
  document.getElementById("audit-info").textContent = "Showing " + (auditOffset + 1) + "-" + Math.min(auditOffset + auditLimit, data.total) + " of " + data.total;
  document.getElementById("audit-prev").disabled = auditOffset === 0;
  document.getElementById("audit-next").disabled = !data.has_more;
}

document.getElementById("audit-search").addEventListener("click", function() { loadAudit(true); });
document.getElementById("audit-prev").addEventListener("click", function() { auditOffset = Math.max(0, auditOffset - auditLimit); loadAudit(); });
document.getElementById("audit-next").addEventListener("click", function() { auditOffset += auditLimit; loadAudit(); });

// Populate API dropdown from stats data
function populateApiFilter(apis) {
  var sel = document.getElementById("audit-api");
  if (sel.options.length > 1) return;
  (apis || []).forEach(function(a) {
    var opt = document.createElement("option");
    opt.value = a.name;
    opt.textContent = a.name;
    sel.appendChild(opt);
  });
}

// Hook into render to populate the API filter
var origRender = render;
render = function(data) {
  origRender(data);
  populateApiFilter(data.apis);
};

// --- Spend Caps ---
async function loadCaps() {
  var tok = gt(); if (!tok) return;
  try {
    var res1 = await fetch(B + "/api/spend-caps", { headers: { Authorization: "Bearer " + tok } });
    var res2 = await fetch(B + "/api/wallets", { headers: { Authorization: "Bearer " + tok } });
    if (res1.ok) renderCaps(await res1.json());
    if (res2.ok) renderWallets(await res2.json());
  } catch(e) {}
}

function renderCaps(data) {
  var tb = document.getElementById("caps-table");
  if (!data.caps || !data.caps.length) {
    tb.innerHTML = '<tr><td colspan="6" class="empty-state">No spend caps configured</td></tr>';
    return;
  }
  tb.innerHTML = data.caps.map(function(c) {
    return '<tr>' +
      '<td class="mono">' + fmtWallet(c.wallet) + '</td>' +
      '<td>' + esc(c.label || "--") + '</td>' +
      '<td class="mono">' + (c.daily_limit_usd !== null ? fmt$(c.daily_limit_usd) : '<span class="dim">unlimited</span>') + '</td>' +
      '<td class="mono">' + (c.monthly_limit_usd !== null ? fmt$(c.monthly_limit_usd) : '<span class="dim">unlimited</span>') + '</td>' +
      '<td class="mono dim">' + fmtTime(c.updated_at) + '</td>' +
      '<td><button class="btn-danger btn-delete-cap" data-wallet="' + esc(c.wallet) + '">Remove</button></td></tr>';
  }).join("");
  tb.querySelectorAll(".btn-delete-cap").forEach(function(btn) {
    btn.addEventListener("click", function() { deleteCap(btn.dataset.wallet); });
  });
}

function renderWallets(data) {
  var tb = document.getElementById("wallets-table");
  if (!data.wallets || !data.wallets.length) {
    tb.innerHTML = '<tr><td colspan="7" class="empty-state">No wallet activity recorded</td></tr>';
    return;
  }
  tb.innerHTML = data.wallets.map(function(w) {
    var capBadge = w.cap ? '<span class="badge badge-ok">capped</span>' : '<span class="badge badge-free">uncapped</span>';
    return '<tr>' +
      '<td class="mono">' + fmtWallet(w.wallet) + '</td>' +
      '<td class="mono green">' + fmt$(w.spend_7d) + '</td>' +
      '<td class="mono green">' + fmt$(w.spend_30d) + '</td>' +
      '<td class="mono">' + fmt$(w.total_spent) + '</td>' +
      '<td class="mono">' + fmtN(w.request_count) + '</td>' +
      '<td class="mono dim">' + fmtTime(w.last_seen) + '</td>' +
      '<td>' + capBadge + '</td></tr>';
  }).join("");
}

document.getElementById("cap-save").addEventListener("click", async function() {
  var tok = gt(); if (!tok) return;
  var msg = document.getElementById("cap-msg");
  var wallet = document.getElementById("cap-wallet").value.trim();
  var label = document.getElementById("cap-label").value.trim() || null;
  var daily = document.getElementById("cap-daily").value;
  var monthly = document.getElementById("cap-monthly").value;

  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    msg.className = "cap-msg err";
    msg.textContent = "Enter a valid 0x wallet address (42 chars)";
    return;
  }

  var body = {
    wallet: wallet,
    label: label,
    daily_limit_usd: daily ? parseFloat(daily) : null,
    monthly_limit_usd: monthly ? parseFloat(monthly) : null
  };

  try {
    var res = await fetch(B + "/api/spend-caps", {
      method: "PUT",
      headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    var data = await res.json();
    if (res.ok) {
      msg.className = "cap-msg ok";
      msg.textContent = "Spend cap saved for " + wallet.substring(0, 8) + "...";
      document.getElementById("cap-wallet").value = "";
      document.getElementById("cap-label").value = "";
      document.getElementById("cap-daily").value = "";
      document.getElementById("cap-monthly").value = "";
      loadCaps();
    } else {
      msg.className = "cap-msg err";
      msg.textContent = data.error || "Failed to save";
    }
  } catch(e) {
    msg.className = "cap-msg err";
    msg.textContent = "Network error";
  }
});

async function deleteCap(wallet) {
  var tok = gt(); if (!tok) return;
  if (!confirm("Remove spend cap for " + wallet.substring(0, 10) + "...?")) return;
  try {
    var res = await fetch(B + "/api/spend-caps/" + encodeURIComponent(wallet), {
      method: "DELETE",
      headers: { Authorization: "Bearer " + tok }
    });
    var data = await res.json();
    if (data.ok) loadCaps();
  } catch(e) {}
}
