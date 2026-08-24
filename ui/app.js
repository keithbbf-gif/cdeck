"use strict";
(function () {
  var REFRESH_S = 10;
  var EVENTS_S = 5;
  var STALE_S = 30;
  var CONSOLE_MAX = 50;
  var FEED_MAX = 200;
  var CREATE_KINDS = ["AGENT", "TOOL", "CONNECTOR", "SKILL"];
  var DEFAULT_URL = "http://127.0.0.1:8791";

  var cfg = { base: DEFAULT_URL, token: "" };
  var connected = false;
  var paused = false;
  var nextAt = 0;
  var nextEventsAt = 0;
  var inflight = false;
  var eventsInflight = false;

  var panels = {
    status: { measuredAtMs: null, error: null },
    health: { measuredAtMs: null, error: null },
    spend: { measuredAtMs: null, error: null },
    jobs: { measuredAtMs: null, error: null },
    rails: { measuredAtMs: null, error: null },
    makers: { measuredAtMs: null, error: null },
    create: { measuredAtMs: null, error: null },
    events: { measuredAtMs: null, error: null }
  };

  // Append-only live feed cursor. Never re-request seq <= lastSeq.
  var lastSeq = 0;
  var feedHasEvents = false;
  var createKind = null;
  var consoleEntries = [];

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
    });
  }

  function toMs(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number" && isFinite(v)) {
      if (v > 1e12) return v;
      if (v > 1e9) return v * 1000;
      return null;
    }
    if (typeof v === "string") {
      var n = Number(v);
      if (isFinite(n) && v.trim() !== "") return toMs(n);
      var p = Date.parse(v);
      if (!isNaN(p)) return p;
    }
    return null;
  }

  function humanAge(sec) {
    if (sec < 0) sec = 0;
    if (sec < 60) return Math.floor(sec) + "s";
    if (sec < 3600) return Math.floor(sec / 60) + "m " + Math.floor(sec % 60) + "s";
    if (sec < 86400) return Math.floor(sec / 3600) + "h " + Math.floor((sec % 3600) / 60) + "m";
    return Math.floor(sec / 86400) + "d " + Math.floor((sec % 86400) / 3600) + "h";
  }

  function usd(v) {
    if (typeof v !== "number" || !isFinite(v)) return "—";
    return "$" + v.toFixed(2);
  }

  function invokeFn() {
    var t = window.__TAURI__;
    if (t && t.core && typeof t.core.invoke === "function") return t.core.invoke.bind(t.core);
    return null;
  }

  function apiCall(path, opts) {
    var method = (opts && opts.method) || "GET";
    var body = opts && opts.body !== undefined ? opts.body : null;
    var inv = invokeFn();
    if (!inv) {
      return Promise.reject(new Error("cDeck shell not ready — open this UI inside the native app"));
    }
    return inv("api_request", {
      method: method,
      path: path,
      serverUrl: cfg.base,
      bearer: cfg.token || null,
      body: body
    }).then(function (r) {
      if (!r.ok) {
        var j = r.json || {};
        var err;
        if (r.status === 401) {
          err = "UNAUTHORIZED — paste a bearer, or start COSMOS with --no-auth";
        } else {
          err = j.error ? String(j.error) : ("HTTP " + r.status);
          if (j.detail) err += " — " + j.detail;
        }
        var e = new Error(err);
        e.status = r.status;
        e.json = j;
        throw e;
      }
      return r.json;
    });
  }
  function apiGet(path) { return apiCall(path); }
  function apiPost(path, body) { return apiCall(path, { method: "POST", body: body }); }

  function addConsole(cls, kind, head, body) {
    consoleEntries.push({ tsMs: Date.now(), cls: cls, kind: kind, head: head, body: body });
    while (consoleEntries.length > CONSOLE_MAX) consoleEntries.shift();
    renderConsole();
  }

  function renderConsole() {
    var el = $("console");
    if (consoleEntries.length === 0) {
      el.innerHTML = '<div class="empty">no commands run yet — results appear here</div>';
      return;
    }
    el.innerHTML = consoleEntries.map(function (e) {
      var ts = new Date(e.tsMs).toLocaleTimeString();
      var h = '<div class="centry ' + e.cls + '">' +
        '<span class="cts">' + esc(ts) + "</span>" +
        (e.kind ? '<span class="ckind">' + esc(e.kind) + "</span>" : "") +
        (e.head ? '<div class="cbody">' + esc(e.head) + "</div>" : "");
      if (e.body) h += "<pre>" + esc(e.body) + "</pre>";
      h += "</div>";
      return h;
    }).join("");
    el.scrollTop = el.scrollHeight;
  }

  function runCommand(text) {
    text = String(text || "").trim();
    if (!text) return;
    if (!connected) {
      addConsole("err", "NOT CONNECTED", "connect to the API before running commands", null);
      return;
    }
    addConsole("cmd", "", "> " + text, null);
    apiPost("/api/v1/command", { text: text }).then(function (d) {
      var pretty = JSON.stringify(d, null, 2);
      if (d && d.error !== undefined && d.error !== null) {
        addConsole("err", String(d.error).toUpperCase(), null, pretty);
      } else {
        addConsole("ok", "OK", null, pretty);
      }
    }).catch(function (e) {
      addConsole("err", "TRANSPORT", e.message || String(e), null);
    });
  }

  $("btnRun").addEventListener("click", function () {
    runCommand($("cmdInput").value);
    $("cmdInput").value = "";
  });
  $("cmdInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { runCommand(this.value); this.value = ""; }
  });
  Array.prototype.forEach.call(document.querySelectorAll(".cmdwrap .quickcmds button"), function (b) {
    b.addEventListener("click", function () { runCommand(this.getAttribute("data-cmd")); });
  });

  function extractMs(d) {
    var m = toMs(d.measured_at_epoch);
    if (m !== null) return m;
    m = toMs(d.measured_at);
    if (m !== null) return m;
    return toMs(d.served_at);
  }

  function renderStatus(d) {
    var lh = d.ledger_head || {};
    var readyCls = d.ready ? "ok" : "bad";
    var readyTxt = d.ready ? "READY" : "NOT READY";
    $("bd-status").innerHTML =
      '<dl class="kv">' +
      '<dt>ready</dt><dd class="big ' + readyCls + '">' + readyTxt + "</dd>" +
      "<dt>root</dt><dd>" + esc(d.root != null ? d.root : "—") + "</dd>" +
      "<dt>tree_id</dt><dd>" + esc(d.tree_id != null ? d.tree_id : "—") + "</dd>" +
      "<dt>ledger head</dt><dd>seq " + esc(lh.seq != null ? lh.seq : "—") +
      ' · <span class="dim">' + esc(lh.event != null ? lh.event : "—") + "</span></dd>" +
      "</dl>";
  }

  function renderHealth(d) {
    var verdict = d.verdict != null ? String(d.verdict) : "UNKNOWN";
    var vu = verdict.toUpperCase();
    var vCls = "unknown";
    if (vu === "GREEN") vCls = "green";
    else if (vu.indexOf("BOARD-BROKEN") === 0) vCls = "broken";
    else if (vu.indexOf("RED") === 0) vCls = "red";
    var h = '<div class="verdict ' + vCls + '">' + esc(vu) + "</div>";
    if (d.diagnosis) h += '<div class="diagnosis">' + esc(d.diagnosis) + "</div>";

    var rows = d.rows || {};
    var names = Object.keys(rows);
    var ncOk = typeof d.negative_control_red === "boolean" ? d.negative_control_red : null;

    if (names.length === 0) {
      h += '<div class="empty">no health rows reported</div>';
    } else {
      var body = names.map(function (name) {
        var r = rows[name] || {};
        var isNC = /negative[\s_-]?control/i.test(name);
        var isRed = r.ok === false;
        var dot = r.ok === true ? '<span class="dot g"></span>'
          : isRed ? '<span class="dot r"></span>'
          : '<span class="warn">?</span>';
        var label = isNC ? ' <span class="nclabel">SUPPOSED TO BE RED</span>' : "";
        return "<tr" + (isNC || isRed ? ' class="' + (isNC ? "ncrow" : "") + '"' : "") + ">" +
          "<td>" + dot + "</td>" +
          "<td>" + esc(name) + label + "</td>" +
          '<td class="' + (isRed && !isNC ? "bad" : "dim") + '">' + esc(r.detail != null ? r.detail : "") + "</td>" +
          "</tr>";
      }).join("");
      h += '<div class="twrap"><table>' +
        "<thead><tr><th></th><th>ROW</th><th>DETAIL</th></tr></thead>" +
        "<tbody>" + body + "</tbody></table></div>";
    }

    var redsTxt = d.reds != null ? String(d.reds) : "—";
    var ncTxt;
    if (ncOk === true) ncTxt = '<span class="ok">RED as designed</span>';
    else if (ncOk === false) ncTxt = '<span class="bad">NOT RED — the checker may be incapable of failing</span>';
    else ncTxt = '<span class="dim">—</span>';
    h += '<dl class="kv" style="margin-top:8px">' +
      "<dt>reds</dt><dd>" + esc(redsTxt) + "</dd>" +
      "<dt>negative control</dt><dd>" + ncTxt + "</dd>" +
      "</dl>";
    $("bd-health").innerHTML = h;
  }

  function renderSpend(d) {
    var rails = d.rails || {};
    var names = Object.keys(rails);
    if (names.length === 0) {
      $("bd-spend").innerHTML = '<div class="empty">no rails reported</div>';
      return;
    }
    var h = '<div class="barlegend">bar vs cap:<i class="s"></i>settled<i class="r"></i>reserved · headroom at/under 0 is RED</div>';
    names.sort().forEach(function (name) {
      var r = rails[name] || {};
      var cap = (typeof r.cap_usd === "number" && isFinite(r.cap_usd)) ? r.cap_usd : null;
      var settled = (typeof r.settled_usd === "number" && isFinite(r.settled_usd)) ? r.settled_usd : 0;
      var reserved = (typeof r.reserved_usd === "number" && isFinite(r.reserved_usd)) ? r.reserved_usd : 0;
      var head = (typeof r.headroom_usd === "number" && isFinite(r.headroom_usd)) ? r.headroom_usd : null;
      var under = head !== null && head <= 0;
      var low = !under && cap !== null && cap > 0 && head !== null && head / cap < 0.1;

      var badges = "";
      if (under) badges += ' <span class="badge bad">UNDER THRESHOLD</span>';
      else if (low) badges += ' <span class="badge">LOW HEADROOM</span>';
      if (typeof r.unpriced_calls === "number" && r.unpriced_calls > 0) {
        badges += ' <span class="badge">' + r.unpriced_calls + " UNPRICED</span>";
      }
      if (r.expiry_risk) {
        badges += ' <span class="badge">EXPIRY RISK: ' + esc(r.expiry_risk) + "</span>";
      }

      var bar;
      if (cap !== null && cap > 0) {
        var sPct = Math.min(100, settled / cap * 100);
        var rPct = Math.min(100 - sPct, reserved / cap * 100);
        var over = under ? '<div class="seg over" style="left:0;width:100%;opacity:.18"></div>' : "";
        bar = '<div class="bar">' + over +
          '<div class="seg settled" style="left:0;width:' + sPct.toFixed(2) + '%"></div>' +
          '<div class="seg reserved" style="left:' + sPct.toFixed(2) + "%;width:" + rPct.toFixed(2) + '%"></div>' +
          "</div>";
      } else {
        bar = '<div class="bar"></div><div class="dim" style="font-size:10px">no cap reported — bar not to scale</div>';
      }

      var ft = '<div class="rail-ft">' +
        "<span>settled " + usd(settled) + "</span>" +
        "<span>reserved " + usd(reserved) + "</span>" +
        "<span>cap " + (cap !== null ? usd(cap) : "—") + "</span>" +
        '<span>headroom <b class="' + (under ? "bad" : (low ? "warn" : "ok")) + '">' + usd(head) + "</b></span>" +
        (typeof r.expires_in_days === "number"
          ? '<span class="' + (r.expiry_risk ? "warn" : "dim") + '">expires in ' + r.expires_in_days + "d</span>" : "") +
        "</div>";

      h += '<div class="rail">' +
        '<div class="rail-hd"><span class="rname">' + esc(name) + "</span>" + badges + "</div>" +
        bar + ft +
        "</div>";
    });
    $("bd-spend").innerHTML = h;
  }

  function renderJobs(d) {
    var jobs = d.jobs || {};
    var byState = {};
    var total = 0;
    Object.keys(jobs).forEach(function (id) {
      var st = String(jobs[id]);
      (byState[st] = byState[st] || []).push(id);
      total++;
    });
    if (total === 0) {
      $("bd-jobs").innerHTML = '<div class="empty">no jobs yet</div>';
      return;
    }
    var stateCls = function (st) {
      var s = st.toUpperCase();
      if (/FAIL|ERROR|DEAD|BROKE/.test(s)) return "bad";
      if (/RUN|ACTIVE|LIVE/.test(s)) return "ok";
      if (/WAIT|PEND|QUEUE|HOLD/.test(s)) return "warn";
      if (/DONE|OK|COMPLETE|SUCC/.test(s)) return "ok";
      return "";
    };
    var order = Object.keys(byState).sort();
    var h = '<dl class="kv" style="margin-bottom:8px"><dt>total</dt><dd class="big">' + total + "</dd></dl>";
    order.forEach(function (st) {
      var ids = byState[st];
      h += '<div class="jobstate">' +
        '<div class="jobstate-hd"><span class="st ' + stateCls(st) + '">' + esc(st) + "</span>" +
        '<span class="ct">×' + ids.length + "</span></div>" +
        '<div class="jobids">' + ids.map(esc).join(" · ") + "</div>" +
        "</div>";
    });
    $("bd-jobs").innerHTML = h;
  }

  function renderRails(d) {
    var m = d.matrix || [];
    if (m.length === 0) {
      $("bd-rails").innerHTML = '<div class="empty">no rails reported</div>';
      return;
    }
    var rows = m.map(function (r) {
      var v = r.verified;
      var vCell;
      if (v === true) vCell = '<span class="ok">✓</span>';
      else if (v === false) vCell = '<span class="bad">✗</span>';
      else vCell = '<span class="warn">UNKNOWN</span>';
      var ageS = (typeof r.age_s === "number" && isFinite(r.age_s)) ? humanAge(r.age_s)
        : '<span class="dim">—</span>';
      return "<tr>" +
        "<td>" + esc(r.link_id != null ? r.link_id : "—") + "</td>" +
        "<td>" + esc(r.rail_type != null ? r.rail_type : "—") + "</td>" +
        "<td>" + esc(r.route != null ? r.route : "—") + "</td>" +
        "<td>" + vCell + "</td>" +
        "<td>" + ageS + "</td>" +
        "</tr>";
    }).join("");
    $("bd-rails").innerHTML =
      '<div class="twrap"><table>' +
      "<thead><tr><th>LINK</th><th>TYPE</th><th>ROUTE</th><th>VERIFIED</th><th>PROBE AGE</th></tr></thead>" +
      "<tbody>" + rows + "</tbody></table></div>";
  }

  function makerCard(m) {
    var srcs = (m.potential_sources && m.potential_sources.length)
      ? m.potential_sources.join(" · ") : "—";
    var tags = (m.tags && m.tags.length) ? m.tags.join(" · ") : "";
    return '<div class="mcard">' +
      '<div class="mtop"><b>' + esc(m.id != null ? m.id : "—") + "</b> " +
      '<span class="chip">' + esc(m.kind != null ? m.kind : "—") + "</span>" +
      (tags ? '<span class="chip">' + esc(tags) + "</span>" : "") + "</div>" +
      "<div class=\"dim\">" + esc(m.function != null ? m.function : "") + "</div>" +
      "<details><summary>open maker</summary>" +
      '<dl class="kv">' +
      "<dt>where</dt><dd>" + esc(m.location != null ? m.location : "—") + "</dd>" +
      "<dt>do</dt><dd>" + esc(m.function != null ? m.function : "—") + "</dd>" +
      "<dt>how</dt><dd>" + esc(m.access != null ? m.access : "—") + "</dd>" +
      "<dt>sources</dt><dd>" + esc(srcs) + "</dd>" +
      "</dl></details></div>";
  }

  function renderMakers(d) {
    var rows = d.makers || [];
    if (rows.length === 0) {
      $("bd-makers").innerHTML = '<div class="empty">no makers registered</div>';
      return;
    }
    var counts = {};
    rows.forEach(function (m) {
      var k = String(m.kind || "OTHER");
      counts[k] = (counts[k] || 0) + 1;
    });
    var chips = Object.keys(counts).sort().map(function (k) {
      return '<span class="chip">' + esc(k) + " <b>" + counts[k] + "</b></span>";
    }).join("");
    $("bd-makers").innerHTML = '<div class="chips">' + chips + "</div>" + rows.map(makerCard).join("");
  }

  function renderCreate(d) {
    var rows = d.makers || [];
    if (rows.length === 0) {
      $("create-cards").innerHTML =
        '<div class="empty">no makers of kind ' + esc(createKind) +
        " — none registered, not an error</div>";
      return;
    }
    $("create-cards").innerHTML = rows.map(makerCard).join("");
  }

  function loadCreate(kind) {
    if (CREATE_KINDS.indexOf(kind) < 0) {
      markError("create", "UNKNOWN_KIND — " + kind + " is not a CREATE kind");
      return;
    }
    createKind = kind;
    Array.prototype.forEach.call(document.querySelectorAll("#create-kinds button"), function (b) {
      if (b.getAttribute("data-kind") === kind) b.classList.add("on");
      else b.classList.remove("on");
    });
    if (!connected) {
      $("create-cards").innerHTML =
        '<div class="empty">not connected — the CREATE panel is a client of the API</div>';
      return;
    }
    refreshPanel("create", "/api/v1/makers?kind=" + encodeURIComponent(kind), extractMs, renderCreate);
  }

  Array.prototype.forEach.call(document.querySelectorAll("#create-kinds button"), function (b) {
    b.addEventListener("click", function () { loadCreate(this.getAttribute("data-kind")); });
  });

  function pollEvents() {
    if (!connected || eventsInflight) return;
    eventsInflight = true;
    apiGet("/api/v1/events?since_seq=" + lastSeq).then(function (d) {
      eventsInflight = false;
      markSuccess("events", Date.now());
      var feed = $("feed");
      var evs = d.events || [];
      if (!feedHasEvents) {
        if (evs.length === 0) {
          feed.innerHTML = '<div class="empty">no events yet — head_seq ' +
            esc(d.head_seq != null ? d.head_seq : "—") + "</div>";
        } else {
          feed.innerHTML = "";
        }
      }
      evs.forEach(function (ev) {
        var seq = (typeof ev.seq === "number") ? ev.seq : null;
        if (seq !== null && seq <= lastSeq) return;
        if (seq !== null && seq > lastSeq) lastSeq = seq;
        feedHasEvents = true;
        var row = document.createElement("div");
        row.className = "fevent";
        var tMs = toMs(ev.t);
        row.innerHTML =
          '<span class="fseq">' + (seq !== null ? seq : "—") + "</span>" +
          '<span class="fname">' + esc(ev.event != null ? ev.event : "—") + "</span>" +
          '<span class="fwriter">' + esc(ev.writer != null ? ev.writer : "—") + "</span>" +
          '<span class="fage"' + (tMs !== null ? ' data-t="' + tMs + '"' : "") + ">" +
          (tMs !== null ? humanAge((Date.now() - tMs) / 1000) : "—") + "</span>";
        feed.appendChild(row);
      });
      while (feed.children.length > FEED_MAX && feed.firstChild) {
        feed.removeChild(feed.firstChild);
      }
      if (evs.length > 0) feed.scrollTop = feed.scrollHeight;
    }).catch(function (e) {
      eventsInflight = false;
      markError("events", e.message || String(e));
    });
  }

  function markSuccess(name, measuredMs) {
    var p = panels[name];
    p.error = null;
    p.measuredAtMs = (measuredMs !== null) ? measuredMs : Date.now();
    var el = $("panel-" + name);
    el.classList.remove("error");
    var old = el.querySelector(".errbox");
    if (old) old.remove();
  }

  function markError(name, msg) {
    var p = panels[name];
    p.error = msg;
    var el = $("panel-" + name);
    el.classList.add("error");
    var bd = el.querySelector(".panel-bd");
    var box = el.querySelector(".errbox");
    if (!box) {
      box = document.createElement("div");
      box.className = "errbox";
      bd.insertBefore(box, bd.firstChild);
    }
    box.innerHTML = "<b>UNREACHABLE</b> — " + esc(msg) +
      (p.measuredAtMs !== null ? ' <span class="dim">(showing last good data below)</span>' : "");
  }

  function refreshPanel(name, path, extract, render) {
    return apiGet(path).then(function (d) {
      render(d);
      markSuccess(name, extract(d));
    }).catch(function (e) {
      markError(name, e.message || String(e));
    });
  }

  var SNAPSHOTS = [
    ["status", "/api/v1/status", extractMs, renderStatus],
    ["health", "/api/v1/health", extractMs, renderHealth],
    ["spend", "/api/v1/spend", extractMs, renderSpend],
    ["jobs", "/api/v1/jobs", extractMs, renderJobs],
    ["rails", "/api/v1/rails", extractMs, renderRails],
    ["makers", "/api/v1/makers", extractMs, renderMakers]
  ];

  function refreshAll() {
    if (!connected || inflight) return;
    inflight = true;
    var t0 = Date.now();
    var ops = SNAPSHOTS.map(function (s) {
      return refreshPanel(s[0], s[1], s[2], s[3]);
    });
    if (createKind) {
      ops.push(refreshPanel("create", "/api/v1/makers?kind=" + encodeURIComponent(createKind), extractMs, renderCreate));
    }
    Promise.all(ops).then(function () {
      inflight = false;
      var snap = SNAPSHOTS.map(function (s) { return s[0]; });
      var anyOk = snap.some(function (k) { return panels[k].error === null && panels[k].measuredAtMs !== null; });
      var allBad = snap.every(function (k) { return panels[k].error !== null; });
      var cs = $("connState");
      var banner = $("downBanner");
      if (allBad) {
        cs.textContent = "SERVER DOWN";
        cs.className = "bad";
        banner.classList.remove("hidden");
      } else {
        banner.classList.add("hidden");
        if (anyOk) {
          cs.textContent = "connected · " + cfg.base + " · rtt " + (Date.now() - t0) + "ms";
          cs.className = "ok";
        }
      }
      nextAt = Date.now() + REFRESH_S * 1000;
      tick();
    });
  }

  function tick() {
    var now = Date.now();
    Object.keys(panels).forEach(function (name) {
      var p = panels[name];
      var el = $("panel-" + name);
      var ageEl = $("age-" + name);
      if (p.measuredAtMs === null) {
        ageEl.textContent = "no data";
        ageEl.className = "age never";
        if (p.error !== null) el.classList.add("error");
        return;
      }
      var ageS = (now - p.measuredAtMs) / 1000;
      ageEl.textContent = humanAge(ageS);
      ageEl.className = "age";
      if (ageS > STALE_S) el.classList.add("stale");
      else el.classList.remove("stale");
    });
    Array.prototype.forEach.call(document.querySelectorAll("#feed .fage[data-t]"), function (el) {
      var t = Number(el.getAttribute("data-t"));
      if (isFinite(t)) el.textContent = humanAge((now - t) / 1000);
    });
    var cd = $("countdown");
    if (!connected) {
      cd.textContent = "refresh idle"; cd.className = "";
    } else if (paused) {
      cd.textContent = "refresh PAUSED"; cd.className = "paused";
    } else {
      var left = Math.max(0, Math.ceil((nextAt - now) / 1000));
      cd.textContent = "next refresh in " + left + "s";
      cd.className = "";
      if (now >= nextAt && !inflight) refreshAll();
      if (now >= nextEventsAt && !eventsInflight) {
        nextEventsAt = now + EVENTS_S * 1000;
        pollEvents();
      }
    }
    $("clock").textContent = "local " + new Date(now).toLocaleTimeString();
  }
  setInterval(tick, 1000);

  function persistUrl(url) {
    var inv = invokeFn();
    if (!inv) return Promise.resolve();
    return inv("save_config", { serverUrl: url }).catch(function (e) {
      addConsole("err", "CONFIG", e.message || String(e), null);
    });
  }

  function doConnect() {
    var newBase = $("apiBase").value.trim();
    if (!newBase) {
      $("connState").textContent = "server URL required";
      $("connState").className = "bad";
      return;
    }
    if (newBase !== cfg.base) {
      lastSeq = 0;
      feedHasEvents = false;
      $("feed").innerHTML = '<div class="empty">connecting — the ledger tail streams here</div>';
      panels.events.measuredAtMs = null;
      panels.events.error = null;
    }
    cfg.base = newBase.replace(/\/+$/, "");
    cfg.token = $("token").value.trim();
    persistUrl(cfg.base);
    connected = true;
    paused = false;
    $("btnPause").disabled = false;
    $("btnPause").textContent = "PAUSE";
    $("connState").textContent = "connecting…";
    $("connState").className = "wait";
    $("downBanner").classList.add("hidden");
    nextAt = Date.now() + REFRESH_S * 1000;
    nextEventsAt = Date.now() + EVENTS_S * 1000;
    refreshAll();
    pollEvents();
  }

  $("btnConnect").addEventListener("click", doConnect);
  $("btnPause").addEventListener("click", function () {
    paused = !paused;
    this.textContent = paused ? "RESUME" : "PAUSE";
    if (!paused) { nextAt = Date.now(); nextEventsAt = Date.now(); }
    tick();
  });
  ["apiBase", "token"].forEach(function (id) {
    $(id).addEventListener("keydown", function (e) {
      if (e.key === "Enter") doConnect();
    });
  });

  function boot() {
    var inv = invokeFn();
    if (!inv) {
      $("connState").textContent = "waiting for cDeck shell…";
      $("connState").className = "wait";
      setTimeout(boot, 120);
      return;
    }
    inv("load_config").then(function (c) {
      var url = c && (c.serverUrl || c.server_url);
      if (url) {
        cfg.base = url;
        $("apiBase").value = url;
      }
      doConnect();
    }).catch(function () {
      doConnect();
    });
  }

  tick();
  boot();
})();
