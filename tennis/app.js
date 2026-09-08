/* Dashboard for the UQTC Tuesday Division C season.
 *
 * Reads one file — season.json, exactly per SCHEMA.md — and renders five views
 * from it. Everything on screen is either a field of that file or arithmetic over
 * its matches; nothing about the competition is hardcoded here, so a tenth round
 * or a seventh team needs no code change. The only structural assumption is the
 * four set slots, which the schema itself fixes.
 *
 * Three deliberate choices worth knowing before editing:
 *
 * 1. Colour is read back out of CSS (readPalette) rather than duplicated as hex
 *    literals. styles.css owns the palette in one place for both modes; the SVG
 *    layer needs concrete values for luminance maths and tooltip keys, so it asks
 *    the cascade instead of keeping a second copy that could drift.
 * 2. Categorical hue is bound to the TEAM, not to a row number: slot = the team's
 *    index in draw-code order, assigned once at load. Hiding a series in a legend
 *    or selecting a team therefore never repaints the others.
 * 3. Charts are drawn at measured pixel width, not scaled through a viewBox, so
 *    axis text stays 11px at phone width instead of shrinking to nothing. That is
 *    why every chart registers a draw() and why resize re-runs them.
 */
'use strict';

/* ============================================================== utilities == */

var SLOTS = ['D1', 'S1', 'S2', 'D2'];
var MAX_SERIES = 6;              // token ceiling we allow ourselves; never generate a hue
var ROW_H = 26;                  // one row of a horizontal bar chart
var BAR_MAX = 18;                // bar thickness cap (spec allows 24; 18 suits these bands)
var GAP = 2;                     // the surface gap, and the surface ring width
var FONT_TICK = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
var FONT_LABEL = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
var FONT_VALUE = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';

var SVGNS = 'http://www.w3.org/2000/svg';

function el(tag, attrs, kids) {
  var node = document.createElement(tag);
  applyAttrs(node, attrs);
  append(node, kids);
  return node;
}

function svg(tag, attrs, kids) {
  var node = document.createElementNS(SVGNS, tag);
  applyAttrs(node, attrs);
  append(node, kids);
  return node;
}

function applyAttrs(node, attrs) {
  if (!attrs) return;
  Object.keys(attrs).forEach(function (k) {
    var v = attrs[k];
    if (v === null || v === undefined || v === false) return;
    if (k === 'text') { node.textContent = String(v); return; }
    if (k === 'html') { throw new Error('refusing innerHTML'); }
    if (k === 'on') {
      Object.keys(v).forEach(function (evt) { node.addEventListener(evt, v[evt]); });
      return;
    }
    if (k === 'style' && typeof v === 'object') {
      Object.keys(v).forEach(function (p) { node.style.setProperty(p, v[p]); });
      return;
    }
    if (k === 'class') { node.setAttribute('class', v); return; }
    if (v === true) { node.setAttribute(k, ''); return; }
    node.setAttribute(k, String(v));
  });
}

function append(node, kids) {
  if (kids === null || kids === undefined) return;
  if (!Array.isArray(kids)) kids = [kids];
  kids.forEach(function (kid) {
    if (kid === null || kid === undefined || kid === false) return;
    node.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
  });
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

var _measure = document.createElement('canvas').getContext('2d');
function textWidth(str, font) {
  _measure.font = font || FONT_LABEL;
  return _measure.measureText(String(str)).width;
}

function num(v, digits) {
  if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) return '—';
  return Number(v).toFixed(digits === undefined ? 0 : digits);
}

function signed(v, digits) {
  if (v === null || v === undefined) return '—';
  var s = num(Math.abs(v), digits);
  if (Number(v) > 0) return '+' + s;
  if (Number(v) < 0) return '−' + s;
  return s;
}

function pct(v) { return v === null || v === undefined ? '—' : Number(v).toFixed(1) + '%'; }

function plural(n, one, many) { return n === 1 ? one : (many || one + 's'); }

function longDate(iso) {
  if (!iso) return '';
  var parts = String(iso).split('-');
  if (parts.length !== 3) return String(iso);
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (isNaN(d.getTime())) return String(iso);
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[d.getDay()] + ' ' + d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
}

function niceMax(v) {
  if (!(v > 0)) return 1;
  var exp = Math.floor(Math.log(v) / Math.LN10);
  var pow = Math.pow(10, exp);
  var f = v / pow;
  var step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * pow;
}

/* Clean tick values. `integer` is for count axes (games, sets) where a 0.5 tick
 * would be nonsense — an all-zero team would otherwise get 0.0 / 0.5 / 1.0. */
function ticks(max, count, integer) {
  var want = count || 4;
  var raw = max / want;
  var exp = Math.floor(Math.log(raw) / Math.LN10);
  var pow = Math.pow(10, exp);
  var f = raw / pow;
  var step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  if (integer) step = Math.max(1, Math.round(step));
  var out = [];
  for (var t = 0; t <= max + step / 1000; t += step) out.push(Math.round(t * 1000) / 1000);
  return out;
}

/* SVG text has no text-overflow, so long category labels get trimmed by
 * measurement. The untrimmed name stays reachable in the tooltip and the table. */
function ellipsize(str, maxWidth, font) {
  var s = String(str);
  if (maxWidth <= 0 || textWidth(s, font) <= maxWidth) return s;
  var cut = s;
  while (cut.length > 1 && textWidth(cut + '…', font) > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return cut + '…';
}

/* Rounded on the data end only, square at the baseline (mark spec). */
function barPath(x, y, w, h, r, end) {
  var rr = Math.max(0, Math.min(r, w, h / 2));
  if (w <= 0.4) return 'M' + x + ' ' + y + 'h' + Math.max(w, 0.4) + 'v' + h + 'h' + -Math.max(w, 0.4) + 'z';
  if (end === 'left') {
    return 'M' + (x + w) + ' ' + y + 'h' + -(w - rr) +
           'a' + rr + ' ' + rr + ' 0 0 0 ' + -rr + ' ' + rr +
           'v' + (h - 2 * rr) +
           'a' + rr + ' ' + rr + ' 0 0 0 ' + rr + ' ' + rr +
           'h' + (w - rr) + 'z';
  }
  if (end === 'top') {
    return 'M' + x + ' ' + (y + h) + 'v' + -(h - rr) +
           'a' + rr + ' ' + rr + ' 0 0 1 ' + rr + ' ' + -rr +
           'h' + (w - 2 * rr) +
           'a' + rr + ' ' + rr + ' 0 0 1 ' + rr + ' ' + rr +
           'v' + (h - rr) + 'z';
  }
  return 'M' + x + ' ' + y + 'h' + (w - rr) +
         'a' + rr + ' ' + rr + ' 0 0 1 ' + rr + ' ' + rr +
         'v' + (h - 2 * rr) +
         'a' + rr + ' ' + rr + ' 0 0 1 ' + -rr + ' ' + rr +
         'h' + -(w - rr) + 'z';
}

/* ================================================================ palette == */

var PAL = {};

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function readPalette() {
  var p = {
    surface: cssVar('--surface-1'),
    surface2: cssVar('--surface-2'),
    text: cssVar('--text-primary'),
    text2: cssVar('--text-secondary'),
    muted: cssVar('--text-muted'),
    grid: cssVar('--grid'),
    axis: cssVar('--axis'),
    deemph: cssVar('--deemph'),
    divPos: cssVar('--div-pos'),
    divNeg: cssVar('--div-neg'),
    divMid: cssVar('--div-mid'),
    series: [],
    seq: []
  };
  for (var i = 1; i <= MAX_SERIES; i++) p.series.push(cssVar('--series-' + i));
  for (var j = 1; j <= 6; j++) p.seq.push(cssVar('--seq-' + j));
  PAL = p;
  return p;
}

function hexToRgb(hex) {
  var h = String(hex).replace('#', '').trim();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  var n = parseInt(h, 16);
  if (isNaN(n)) return [128, 128, 128];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* Relative luminance, only ever used to pick ink-or-white for text set inside a
 * filled cell — the one place the spec allows text over a data colour. */
function luminance(hex) {
  var c = hexToRgb(hex).map(function (v) {
    var s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function inkOn(hex) { return luminance(hex) > 0.42 ? '#0b0b0b' : '#ffffff'; }

/* ============================================================== app state == */

var S = null;                    // the season document
var IDX = {};                    // derived lookups
var CHARTS = [];                 // {figure, draw} for the current view
var SOURCE_NOTE = '';
var PLAYER_SORT = { key: 'name', dir: 1 };

function indexSeason(season) {
  var idx = {
    teamByCode: {}, teamBySlug: {}, playerBySlug: {}, matchById: {},
    slotOf: {}, teamsOrdered: [], ladder: [], overflowTeams: []
  };
  var teams = (season.teams || []).slice();
  teams.forEach(function (t) {
    idx.teamByCode[t.code] = t;
    idx.teamBySlug[t.slug] = t;
  });
  // Hue slot follows the team entity, fixed at load in draw-code order.
  idx.teamsOrdered = teams.slice().sort(function (a, b) { return a.code - b.code; });
  idx.teamsOrdered.forEach(function (t, i) {
    if (i < MAX_SERIES) idx.slotOf[t.code] = i;
    else idx.overflowTeams.push(t);
  });
  (season.players || []).forEach(function (p) { idx.playerBySlug[p.slug] = p; });
  (season.matches || []).forEach(function (m) { idx.matchById[m.id] = m; });
  idx.ladder = teams.slice().sort(function (a, b) {
    if (a.position !== b.position) return (a.position || 99) - (b.position || 99);
    return String(a.name).localeCompare(String(b.name));
  });
  return idx;
}

function teamColor(code) {
  var slot = IDX.slotOf[code];
  return slot === undefined ? PAL.deemph : PAL.series[slot];
}

function teamOf(code) { return IDX.teamByCode[code] || null; }
function teamName(code) { var t = teamOf(code); return t ? t.name : 'Team ' + code; }
function teamShort(code) { var t = teamOf(code); return t ? (t.short || t.name) : 'Team ' + code; }
function playerName(slug) {
  var p = IDX.playerBySlug[slug];
  if (p) return p.name;
  var names = S && S.player_names ? S.player_names : {};
  return names[slug] || slug;
}

function h2hKey(a, b) { return Math.min(a, b) + ':' + Math.max(a, b); }

function h2hFor(a, b) {
  var rec = (S.head_to_head || {})[h2hKey(a, b)];
  if (!rec) return null;
  var low = Math.min(a, b) === a;
  return {
    played: rec.played,
    won: low ? rec.wins_low : rec.wins_high,
    lost: low ? rec.wins_high : rec.wins_low,
    drawn: rec.draws,
    gamesFor: low ? rec.games_low : rec.games_high,
    gamesAgainst: low ? rec.games_high : rec.games_low
  };
}

function matchesOfTeam(code) {
  return (S.matches || []).filter(function (m) {
    return m.home_code === code || m.away_code === code;
  }).sort(byRound);
}

function byRound(a, b) {
  var ra = roundOrder(a.round), rb = roundOrder(b.round);
  if (ra !== rb) return ra - rb;
  return String(a.id).localeCompare(String(b.id));
}

function roundOrder(numberLike) {
  var n = parseInt(numberLike, 10);
  return isNaN(n) ? 999 : n;
}

/* Every set a player appeared in, derived from the match list — the schema keeps
 * per-player aggregates but not their per-set trail, and the player view needs
 * the trail to show results rather than only totals. */
function setsOfPlayer(slug) {
  var out = [];
  (S.matches || []).sort(byRound).forEach(function (m) {
    (m.sets || []).forEach(function (st) {
      var side = null;
      if ((st.home_players || []).indexOf(slug) >= 0) side = 'home';
      else if ((st.away_players || []).indexOf(slug) >= 0) side = 'away';
      if (!side) return;
      var mine = side === 'home' ? st.home_games : st.away_games;
      var theirs = side === 'home' ? st.away_games : st.home_games;
      var partner = (side === 'home' ? st.home_players : st.away_players)
        .filter(function (s) { return s !== slug; });
      out.push({
        match: m, set: st, side: side,
        gamesFor: mine, gamesAgainst: theirs,
        partners: partner,
        opponents: (side === 'home' ? st.away_players : st.home_players).slice(),
        won: st.winner === side,
        decided: !!st.winner,
        opponentTeam: side === 'home' ? m.away_code : m.home_code
      });
    });
  });
  return out;
}

/* ================================================================ tooltip == */

var TIP = null;

function tipNode() {
  if (!TIP) {
    TIP = el('div', { id: 'tooltip', role: 'status', 'aria-live': 'polite', hidden: true });
    document.body.appendChild(TIP);
  }
  return TIP;
}

/* rows: [{color, name, value, kind:'line'|'rect'}] — value leads, name follows. */
function showTip(title, rows, x, y) {
  var t = tipNode();
  clear(t);
  t.appendChild(el('div', { class: 'tt-title', text: title }));
  (rows || []).forEach(function (r) {
    var row = el('div', { class: 'tt-row' });
    if (r.color) {
      row.appendChild(el('span', {
        class: 'tt-key' + (r.kind === 'rect' ? ' rect' : ''),
        style: { background: r.color }
      }));
    }
    row.appendChild(el('span', { class: 'tt-name', text: r.name }));
    row.appendChild(el('span', { class: 'tt-val', text: r.value }));
    t.appendChild(row);
  });
  t.hidden = false;
  var box = t.getBoundingClientRect();
  var left = Math.min(Math.max(8, x + 14), window.innerWidth - box.width - 8);
  var top = Math.min(Math.max(8, y - box.height - 12), window.innerHeight - box.height - 8);
  t.style.left = left + 'px';
  t.style.top = top + 'px';
}

function hideTip() { if (TIP) TIP.hidden = true; }

/* Hover and keyboard focus produce the same readout. */
function bindTip(node, get) {
  node.addEventListener('pointerenter', function (e) { place(e.clientX, e.clientY); });
  node.addEventListener('pointermove', function (e) { place(e.clientX, e.clientY); });
  node.addEventListener('pointerleave', hideTip);
  node.addEventListener('focus', function () {
    var b = node.getBoundingClientRect();
    place(b.left + b.width / 2, b.top + b.height / 2);
  });
  node.addEventListener('blur', hideTip);
  function place(x, y) {
    var data = get();
    if (data) showTip(data.title, data.rows, x, y);
  }
}

/* ============================================================ chart shells == */

function chartCard(opts) {
  var fig = el('figure', { class: 'card chart-card' });
  var cap = el('figcaption');
  cap.appendChild(el('h3', { text: opts.title }));
  if (opts.sub) cap.appendChild(el('p', { class: 'sub', text: opts.sub }));
  var plot = el('div', { class: 'plot' });
  var tableWrap = el('div', { class: 'table-wrap', hidden: true });

  if (opts.table) {
    var toggle = el('button', {
      class: 'btn table-toggle', type: 'button', 'aria-expanded': 'false',
      text: 'Values'
    });
    toggle.addEventListener('click', function () {
      var open = tableWrap.hidden;
      tableWrap.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.textContent = open ? 'Hide values' : 'Values';
    });
    cap.appendChild(toggle);
  }
  fig.appendChild(cap);
  if (opts.legend) fig.appendChild(opts.legend);
  fig.appendChild(plot);
  if (opts.table) tableWrap.appendChild(opts.table);
  fig.appendChild(tableWrap);
  if (opts.footer) fig.appendChild(opts.footer);

  if (opts.draw) CHARTS.push({ figure: fig, plot: plot, draw: opts.draw });
  return fig;
}

function legendBar(items, onToggle) {
  var wrap = el('div', { class: 'legend' });
  items.forEach(function (it) {
    var key = el('span', {
      class: it.kind === 'line' ? 'key-line' : 'key-rect',
      style: { background: it.color }
    });
    if (onToggle) {
      var btn = el('button', {
        class: 'legend-item', type: 'button',
        'aria-pressed': it.on === false ? 'false' : 'true',
        title: 'Show or hide ' + it.name
      }, [key, el('span', { text: it.name })]);
      if (it.on === false) btn.classList.add('off');
      btn.addEventListener('click', function () { onToggle(it, btn); });
      wrap.appendChild(btn);
    } else {
      wrap.appendChild(el('span', { class: 'legend-item' }, [key, el('span', { text: it.name })]));
    }
  });
  return wrap;
}

function emptyPlot(plot, message) {
  clear(plot);
  plot.appendChild(el('p', { class: 'empty', text: message }));
}

function table(head, rows, opts) {
  var o = opts || {};
  var t = el('table');
  if (o.caption) t.appendChild(el('caption', { text: o.caption }));
  var thead = el('thead');
  var tr = el('tr');
  head.forEach(function (h) {
    var cell = el('th', { scope: 'col' });
    if (typeof h === 'object' && h !== null) {
      if (h.sortable) {
        cell.className = 'sortable';
        var btn = el('button', { type: 'button' }, [
          el('span', { text: h.label }),
          el('span', { class: 'arrow', text: h.arrow || '' })
        ]);
        btn.addEventListener('click', h.onSort);
        cell.appendChild(btn);
        if (h.ariaSort) cell.setAttribute('aria-sort', h.ariaSort);
      } else {
        cell.textContent = h.label;
      }
      if (h.title) cell.setAttribute('title', h.title);
    } else {
      cell.textContent = h;
    }
    tr.appendChild(cell);
  });
  thead.appendChild(tr);
  t.appendChild(thead);
  var tbody = el('tbody');
  rows.forEach(function (r) {
    var row = el('tr');
    var cells = Array.isArray(r) ? r : r.cells;
    cells.forEach(function (c, i) {
      var tag = i === 0 && o.rowHeader !== false ? 'th' : 'td';
      var cell = el(tag, i === 0 && o.rowHeader !== false ? { scope: 'row' } : null);
      if (c && typeof c === 'object' && c.nodeType) cell.appendChild(c);
      else if (c && typeof c === 'object') {
        cell.textContent = c.text === undefined ? '' : String(c.text);
        if (c.cls) cell.className = c.cls;
        if (c.style) applyAttrs(cell, { style: c.style });
      } else {
        cell.textContent = c === null || c === undefined ? '—' : String(c);
      }
      row.appendChild(cell);
    });
    if (!Array.isArray(r) && r.href) {
      row.classList.add('clickable');
      row.addEventListener('click', function (e) {
        if (e.target.closest('a, button')) return;
        location.hash = r.href;
      });
    }
    tbody.appendChild(row);
  });
  t.appendChild(tbody);
  return t;
}

/* =========================================================== chart: hbars == */

/* Horizontal bars in two modes:
 *   single    — one measure from a zero baseline (magnitude ranking)
 *   diverging — a for/against pair sharing one games axis around a zero line
 * Both label the value at the tip, outside the bar when it fits there. */
function hbarCard(opts) {
  var rows = opts.rows || [];
  var mode = opts.mode || 'single';

  var tableRows = rows.map(function (r) { return opts.tableRow(r); });
  var card = chartCard({
    title: opts.title,
    sub: opts.sub,
    legend: opts.legend,
    table: rows.length ? table(opts.tableHead, tableRows, { caption: opts.tableCaption }) : null,
    footer: opts.footer,
    draw: function (plot, width) {
      if (!rows.length) { emptyPlot(plot, opts.empty || 'Nothing to plot yet.'); return; }
      draw(plot, width);
    }
  });
  return card;

  function draw(plot, width) {
    clear(plot);
    // Widest value text sets the gutter, so a tip label can never reach the row
    // label. Diverging needs the gutter on both sides — the left arm's label
    // grows leftward out of the plot.
    var labelW = 0, valueW = 22;
    rows.forEach(function (r) {
      labelW = Math.max(labelW, textWidth(r.label, FONT_LABEL));
      valueW = Math.max(valueW, textWidth(r.valueText, FONT_VALUE),
                        textWidth(r.negText || '', FONT_VALUE));
    });
    valueW = Math.ceil(valueW) + 8;
    labelW = Math.min(Math.ceil(labelW) + 10, Math.max(56, width * 0.34));
    // padBottom carries the tick row AND the axis title on its own line, so the
    // container never crops the axis band (and the two never collide).
    var padTop = 6, padBottom = opts.axisLabel ? 38 : 22;
    var gutters = labelW + valueW * (mode === 'diverging' ? 2 : 1);
    var plotW = Math.max(40, width - gutters);
    var height = padTop + rows.length * ROW_H + padBottom;
    var x0 = mode === 'diverging' ? labelW + valueW : labelW;

    var maxAbs = 0;
    rows.forEach(function (r) {
      maxAbs = Math.max(maxAbs, Math.abs(r.value || 0), Math.abs(r.neg || 0));
    });
    var scaleMax = niceMax(maxAbs || 1);
    var zeroX = mode === 'diverging' ? x0 + plotW / 2 : x0;
    var unit = mode === 'diverging' ? (plotW / 2) / scaleMax : plotW / scaleMax;

    var root = svg('svg', {
      width: width, height: height, viewBox: '0 0 ' + width + ' ' + height,
      role: 'img', 'aria-label': opts.title + '. ' + (opts.sub || '')
    });

    // gridlines: solid hairlines, one shade off the surface
    var gridVals = ticks(scaleMax, mode === 'diverging' ? 2 : 4, opts.integer);
    var decimals = gridVals.length > 1 && gridVals[1] < 1 ? 1 : 0;
    var axisY = padTop + rows.length * ROW_H;
    gridVals.forEach(function (v) {
      // zero sits on the shared baseline, so it is labelled once, not per arm
      var positions = (mode === 'diverging' && v !== 0)
        ? [zeroX - v * unit, zeroX + v * unit]
        : [zeroX + v * unit];
      positions.forEach(function (x) {
        if (v !== 0) {
          root.appendChild(svg('line', {
            x1: x, y1: padTop, x2: x, y2: axisY,
            stroke: PAL.grid, 'stroke-width': 1, 'shape-rendering': 'crispEdges'
          }));
        }
        root.appendChild(svg('text', {
          x: x, y: axisY + 14, fill: PAL.muted, 'font-size': 11,
          'text-anchor': 'middle', text: num(v, decimals)
        }));
      });
    });
    root.appendChild(svg('line', {
      x1: zeroX, y1: padTop, x2: zeroX, y2: axisY,
      stroke: PAL.axis, 'stroke-width': 1, 'shape-rendering': 'crispEdges'
    }));
    if (opts.axisLabel) {
      root.appendChild(svg('text', {
        x: x0 + plotW / 2, y: axisY + 32,
        fill: PAL.muted, 'font-size': 11,
        'text-anchor': 'middle', text: opts.axisLabel
      }));
    }

    rows.forEach(function (r, i) {
      var bandY = padTop + i * ROW_H;
      var thick = Math.min(BAR_MAX, ROW_H - 8);
      var barY = bandY + (ROW_H - thick) / 2;
      var group = r.href ? svg('a', { href: r.href, tabindex: 0 }) : svg('g', { tabindex: 0 });
      group.setAttribute('role', r.href ? 'link' : 'img');
      group.setAttribute('aria-label', r.aria || (r.label + ': ' + r.valueText));
      group.setAttribute('class', 'mark');

      var shown = ellipsize(r.label, labelW - 10, FONT_LABEL);
      var labelText = svg('text', {
        x: labelW - 8, y: bandY + ROW_H / 2 + 4, 'text-anchor': 'end',
        fill: r.dim ? PAL.muted : PAL.text2, 'font-size': 12, text: shown
      });
      if (shown !== r.label) labelText.appendChild(svg('title', { text: r.label }));
      group.appendChild(labelText);

      var posColor = r.color || (mode === 'diverging' ? PAL.divPos : PAL.series[0]);
      var negColor = r.negColor || PAL.divNeg;

      if (mode === 'diverging') {
        var pw = Math.abs(r.value || 0) * unit;
        var nw = Math.abs(r.neg || 0) * unit;
        if (pw > 0) {
          group.appendChild(svg('path', {
            d: barPath(zeroX + GAP / 2, barY, Math.max(pw - GAP / 2, 0.5), thick, 4, 'right'),
            fill: posColor
          }));
        }
        if (nw > 0) {
          group.appendChild(svg('path', {
            d: barPath(zeroX - GAP / 2 - Math.max(nw - GAP / 2, 0.5), barY,
                       Math.max(nw - GAP / 2, 0.5), thick, 4, 'left'),
            fill: negColor
          }));
        }
        group.appendChild(svg('text', {
          x: zeroX + pw + 6, y: barY + thick / 2 + 4, fill: PAL.text,
          'font-size': 12, 'font-weight': 600, text: r.valueText
        }));
        group.appendChild(svg('text', {
          x: zeroX - nw - 6, y: barY + thick / 2 + 4, fill: PAL.text2,
          'font-size': 12, 'text-anchor': 'end', text: r.negText
        }));
      } else {
        var w = Math.max((r.value || 0) * unit, r.value ? 0.5 : 0);
        if (w > 0) {
          group.appendChild(svg('path', {
            d: barPath(zeroX, barY, w, thick, 4, 'right'), fill: posColor
          }));
        }
        // Label outside the tip when there is room; never clipped inside a short bar.
        var tw = textWidth(r.valueText, FONT_VALUE);
        var outside = zeroX + w + 6 + tw <= width - 2;
        if (outside) {
          group.appendChild(svg('text', {
            x: zeroX + w + 6, y: barY + thick / 2 + 4, fill: PAL.text,
            'font-size': 12, 'font-weight': 600, text: r.valueText
          }));
        } else if (w > tw + 16) {
          group.appendChild(svg('text', {
            x: zeroX + w - 6, y: barY + thick / 2 + 4, fill: inkOn(posColor),
            'font-size': 12, 'font-weight': 600, 'text-anchor': 'end', text: r.valueText
          }));
        }
      }

      // hit target spans the whole band, comfortably bigger than the mark
      var hit = svg('rect', {
        class: 'hit', x: 0, y: bandY, width: width, height: ROW_H
      });
      group.appendChild(hit);
      bindTip(group, function () { return r.tip; });
      root.appendChild(group);
    });

    plot.appendChild(root);
  }
}

/* ============================================================ chart: line == */

/* Multi-series line with an inverted y (ladder position 1 at the top), a
 * crosshair that snaps to the nearest round, direct labels at the right edge and
 * a toggle-to-isolate legend. Hue is the team's own slot, so hiding a series
 * never repaints the survivors. */
function ladderLineCard(opts) {
  var series = opts.series || [];
  var hidden = {};
  var legend = legendBar(series.map(function (s) {
    return { name: s.label, color: s.color, kind: 'line' };
  }), function (item, btn) {
    var match = series.filter(function (s) { return s.label === item.name; })[0];
    if (!match) return;
    hidden[match.key] = !hidden[match.key];
    btn.setAttribute('aria-pressed', hidden[match.key] ? 'false' : 'true');
    btn.classList.toggle('off', !!hidden[match.key]);
    redraw();
  });

  var xs = opts.xs || [];
  var tableHead = ['Team'].concat(xs.map(function (x) { return 'R' + x; }));
  var tableRows = series.map(function (s) {
    return [s.label].concat(xs.map(function (x) {
      var pt = s.points.filter(function (p) { return p.x === x; })[0];
      return pt ? String(pt.y) : '—';
    }));
  });

  var plotRef = null, widthRef = 0;
  var card = chartCard({
    title: opts.title, sub: opts.sub, legend: legend,
    table: series.length ? table(tableHead, tableRows, { caption: opts.tableCaption }) : null,
    draw: function (plot, width) {
      plotRef = plot; widthRef = width;
      if (!series.length || !xs.length) {
        emptyPlot(plot, opts.empty || 'No rounds played yet.');
        return;
      }
      draw(plot, width);
    }
  });
  return card;

  function redraw() { if (plotRef) draw(plotRef, widthRef); }

  function draw(plot, width) {
    clear(plot);
    var maxPos = 1;
    series.forEach(function (s) {
      s.points.forEach(function (p) { maxPos = Math.max(maxPos, p.y); });
    });
    var labelW = 0;
    series.forEach(function (s) {
      if (!hidden[s.key]) labelW = Math.max(labelW, textWidth(s.label, FONT_LABEL) + 24);
    });
    // The right gutter holds the direct labels; cap it so the plot keeps most of
    // the width, then trim the labels to whatever the cap left them.
    var padL = 30, padR = Math.min(labelW + 12, Math.max(48, width * 0.34));
    var directLabelW = padR - 33;
    var padT = 10, padB = 30;
    var rowH = 26;
    var plotH = Math.max(rowH * (maxPos - 1), rowH);
    var height = padT + plotH + padB;
    var plotW = Math.max(40, width - padL - padR);
    var stepX = xs.length > 1 ? plotW / (xs.length - 1) : 0;

    function xAt(x) { return padL + xs.indexOf(x) * stepX + (xs.length > 1 ? 0 : plotW / 2); }
    function yAt(pos) { return padT + (pos - 1) * (plotH / Math.max(maxPos - 1, 1)); }

    var root = svg('svg', {
      width: width, height: height, viewBox: '0 0 ' + width + ' ' + height,
      role: 'img', 'aria-label': opts.title + '. ' + (opts.sub || '')
    });

    for (var pos = 1; pos <= maxPos; pos++) {
      root.appendChild(svg('line', {
        x1: padL, y1: yAt(pos), x2: padL + plotW, y2: yAt(pos),
        stroke: PAL.grid, 'stroke-width': 1, 'shape-rendering': 'crispEdges'
      }));
      root.appendChild(svg('text', {
        x: padL - 8, y: yAt(pos) + 4, 'text-anchor': 'end',
        fill: PAL.muted, 'font-size': 11, text: String(pos)
      }));
    }
    xs.forEach(function (x) {
      root.appendChild(svg('text', {
        x: xAt(x), y: height - 12, 'text-anchor': 'middle',
        fill: PAL.muted, 'font-size': 11, text: 'R' + x
      }));
    });
    root.appendChild(svg('text', {
      x: padL, y: height - 1, fill: PAL.muted, 'font-size': 11,
      text: 'Round →   (1 = top of the ladder)'
    }));

    var crosshair = svg('line', {
      y1: padT, y2: padT + plotH, stroke: PAL.axis, 'stroke-width': 1,
      'shape-rendering': 'crispEdges', opacity: 0
    });
    root.appendChild(crosshair);

    var visible = series.filter(function (s) { return !hidden[s.key]; });
    visible.forEach(function (s) {
      var pts = s.points.filter(function (p) { return xs.indexOf(p.x) >= 0; });
      if (!pts.length) return;
      var d = pts.map(function (p, i) {
        return (i ? 'L' : 'M') + xAt(p.x) + ' ' + yAt(p.y);
      }).join(' ');
      var stroke = s.dim ? PAL.deemph : s.color;
      root.appendChild(svg('path', {
        d: d, fill: 'none', stroke: stroke, 'stroke-width': s.dim ? 2 : 2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        opacity: s.dim ? 0.9 : 1
      }));
      pts.forEach(function (p) {
        root.appendChild(svg('circle', {
          cx: xAt(p.x), cy: yAt(p.y), r: 4, fill: stroke,
          stroke: PAL.surface, 'stroke-width': GAP
        }));
      });
      var last = pts[pts.length - 1];
      // direct label: a short line-key carries the hue, the text stays in ink
      root.appendChild(svg('line', {
        x1: xAt(last.x) + 10, y1: yAt(last.y), x2: xAt(last.x) + 24, y2: yAt(last.y),
        stroke: stroke, 'stroke-width': 2, 'stroke-linecap': 'round'
      }));
      var shown = ellipsize(s.label, directLabelW, FONT_LABEL);
      var labelText = svg('text', {
        x: xAt(last.x) + 29, y: yAt(last.y) + 4, fill: s.dim ? PAL.muted : PAL.text2,
        'font-size': 12, text: shown
      });
      if (shown !== s.label) labelText.appendChild(svg('title', { text: s.label }));
      root.appendChild(labelText);
    });

    // one crosshair layer: the reader aims at a round, not at a 2px line.
    // It pads half a step past each end round so the edges stay easy to hit,
    // without ever reaching outside the drawn width.
    var overlayX = Math.max(0, padL - stepX / 2);
    var overlayW = Math.min(width - overlayX, plotW + stepX);
    var overlay = svg('rect', {
      class: 'hit', x: overlayX, y: padT,
      width: overlayW, height: plotH, tabindex: 0,
      role: 'img', 'aria-label': 'Ladder positions by round. Use left and right arrow keys.'
    });
    var cursor = 0;
    function readout(clientX, clientY) {
      var x = xs[cursor];
      crosshair.setAttribute('x1', xAt(x));
      crosshair.setAttribute('x2', xAt(x));
      crosshair.setAttribute('opacity', 1);
      var rows = visible.map(function (s) {
        var pt = s.points.filter(function (p) { return p.x === x; })[0];
        return {
          color: s.dim ? PAL.deemph : s.color, kind: 'line', name: s.label,
          value: pt ? opts.valueText(pt) : '—'
        };
      }).sort(function (a, b) { return a.value.localeCompare(b.value, undefined, { numeric: true }); });
      showTip('Round ' + x, rows, clientX, clientY);
    }
    overlay.addEventListener('pointermove', function (e) {
      var box = root.getBoundingClientRect();
      var rel = e.clientX - box.left - padL;
      cursor = Math.max(0, Math.min(xs.length - 1, Math.round(stepX ? rel / stepX : 0)));
      readout(e.clientX, e.clientY);
    });
    overlay.addEventListener('pointerleave', function () {
      crosshair.setAttribute('opacity', 0);
      hideTip();
    });
    overlay.addEventListener('focus', function () {
      var box = overlay.getBoundingClientRect();
      readout(box.left + box.width / 2, box.top + 20);
    });
    overlay.addEventListener('blur', function () {
      crosshair.setAttribute('opacity', 0);
      hideTip();
    });
    overlay.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') cursor = Math.min(xs.length - 1, cursor + 1);
      else if (e.key === 'ArrowLeft') cursor = Math.max(0, cursor - 1);
      else return;
      e.preventDefault();
      var box = overlay.getBoundingClientRect();
      readout(box.left + box.width / 2, box.top + 20);
    });
    root.appendChild(overlay);

    plot.appendChild(root);
  }
}

/* ========================================================= chart: h2h grid == */

/* A heatmap that IS a table: one hue light->dark on games won, the number
 * printed in every cell in ink chosen by the fill's luminance, so the colour
 * never carries the value alone. */
function h2hGridCard() {
  var teams = IDX.teamsOrdered;
  var maxGames = 1;
  teams.forEach(function (row) {
    teams.forEach(function (col) {
      if (row.code === col.code) return;
      var rec = h2hFor(row.code, col.code);
      if (rec) maxGames = Math.max(maxGames, rec.gamesFor);
    });
  });

  var wrap = el('div', { class: 'table-wrap' });
  var t = el('table');
  t.appendChild(el('caption', {
    text: 'Games won by the row team against the column team. Blank where the fixture has not been played.'
  }));
  var thead = el('thead');
  var hrow = el('tr');
  hrow.appendChild(el('th', { scope: 'col', text: 'Team' }));
  teams.forEach(function (col) {
    hrow.appendChild(el('th', { scope: 'col', title: col.name, text: col.short || col.name }));
  });
  hrow.appendChild(el('th', { scope: 'col', text: 'W–L' }));
  thead.appendChild(hrow);
  t.appendChild(thead);

  var tbody = el('tbody');
  teams.forEach(function (row) {
    var tr = el('tr');
    tr.appendChild(el('th', { scope: 'row' }, [teamLink(row)]));
    var w = 0, l = 0, d = 0;
    teams.forEach(function (col) {
      var td = el('td');
      if (row.code === col.code) {
        td.className = 'muted';
        td.textContent = '—';
        td.style.setProperty('background', PAL.surface2);
        tr.appendChild(td);
        return;
      }
      var rec = h2hFor(row.code, col.code);
      if (!rec || !rec.played) {
        td.className = 'muted';
        td.textContent = '·';
        td.setAttribute('title', row.name + ' v ' + col.name + ': not played yet');
        tr.appendChild(td);
        return;
      }
      w += rec.won; l += rec.lost; d += rec.drawn;
      var frac = rec.gamesFor / maxGames;
      var step = Math.max(0, Math.min(PAL.seq.length - 1, Math.round(frac * (PAL.seq.length - 1))));
      var fill = PAL.seq[step];
      td.textContent = rec.gamesFor + '–' + rec.gamesAgainst;
      td.style.setProperty('background', fill);
      td.style.setProperty('color', inkOn(fill));
      td.style.setProperty('font-weight', '600');
      td.setAttribute('title', row.name + ' won ' + rec.gamesFor + ' games, ' +
        col.name + ' won ' + rec.gamesAgainst);
      tr.appendChild(td);
    });
    tr.appendChild(el('td', { text: w + '–' + l + (d ? '–' + d : '') }));
    tbody.appendChild(tr);
  });
  t.appendChild(tbody);
  wrap.appendChild(t);

  var scale = el('div', { class: 'scale-legend' }, [
    el('span', { text: '0 games' }),
    el('span', { class: 'scale-ramp', 'aria-hidden': 'true' }),
    el('span', { text: maxGames + ' games' })
  ]);

  var fig = el('figure', { class: 'card chart-card' });
  var cap = el('figcaption');
  cap.appendChild(el('h3', { text: 'Head to head' }));
  cap.appendChild(el('p', { class: 'sub', text: 'Every completed meeting, games for and against.' }));
  fig.appendChild(cap);
  fig.appendChild(wrap);
  fig.appendChild(scale);
  return fig;
}

/* ================================================================= pieces == */

function teamLink(team, opts) {
  var o = opts || {};
  return el('a', { class: 'entity', href: '#/team/' + team.slug, title: team.name }, [
    el('span', { class: 'chip', style: { background: teamColor(team.code) }, 'aria-hidden': 'true' }),
    el('span', { class: 'name', text: o.long ? team.name : (team.short || team.name) })
  ]);
}

function teamLinkByCode(code, opts) {
  var t = teamOf(code);
  if (t) return teamLink(t, opts);
  return el('span', { text: teamName(code) });
}

function playerLink(slug) {
  var p = IDX.playerBySlug[slug];
  var name = playerName(slug);
  if (!p) return el('span', { text: name, title: 'Not in the registered player list' });
  return el('a', { class: 'entity', href: '#/player/' + p.slug }, [
    el('span', { class: 'chip', style: { background: teamColor(p.team_code) }, 'aria-hidden': 'true' }),
    el('span', { class: 'name', text: name })
  ]);
}

function streakWords(streak) {
  if (!streak || !streak.length) return '—';
  var word = streak.type === 'W' ? plural(streak.length, 'win')
    : streak.type === 'L' ? plural(streak.length, 'loss', 'losses')
    : plural(streak.length, 'draw');
  return streak.length + ' ' + word;
}

function formRun(form) {
  var run = el('span', { class: 'form-run' });
  if (!form || !form.length) return el('span', { class: 'muted', text: '—' });
  form.forEach(function (r) {
    run.appendChild(el('span', {
      class: 'res ' + r, text: r,
      title: r === 'W' ? 'Win' : r === 'L' ? 'Loss' : 'Draw'
    }));
  });
  return run;
}

function tile(label, value, foot) {
  return el('div', { class: 'card tile' }, [
    el('div', { class: 'label', text: label }),
    el('div', { class: 'value', text: value }),
    foot ? el('div', { class: 'foot', text: foot }) : null
  ]);
}

function note(kind, label, message) {
  return el('p', { class: 'note ' + kind }, [
    el('span', { class: 'ico', 'aria-hidden': 'true', text: kind === 'critical' ? '✕' : '!' }),
    el('span', {}, [el('strong', { text: label + ': ' }), document.createTextNode(message)])
  ]);
}

function sectionTitle(text) { return el('h2', { class: 'section', text: text }); }

/* ============================================================ match render == */

function setRow(m, st) {
  function names(list) {
    var wrap = el('span');
    (list || []).forEach(function (slug, i) {
      if (i) wrap.appendChild(document.createTextNode(' + '));
      wrap.appendChild(playerLink(slug));
    });
    if (!list || !list.length) wrap.appendChild(el('span', { class: 'muted', text: 'not recorded' }));
    return wrap;
  }
  var homeCls = st.winner === 'home' ? 'win' : 'lose';
  var awayCls = st.winner === 'away' ? 'win' : 'lose';
  var status = st.status && st.status !== 'played' ? st.status : (st.completed ? '' : 'unfinished');
  return [
    st.label || st.slot,
    names(st.home_players),
    { text: num(st.home_games), cls: homeCls },
    { text: num(st.away_games), cls: awayCls },
    names(st.away_players),
    { text: status ? status.charAt(0).toUpperCase() + status.slice(1) : '—',
      cls: status ? '' : 'muted' }
  ];
}

function matchCard(m, opts) {
  var o = opts || {};
  var d = el('details', { class: 'match' });
  if (o.open) d.setAttribute('open', '');
  var summary = el('summary');
  summary.appendChild(el('span', { class: 'side' }, [
    el('span', { class: 'chip', style: { background: teamColor(m.home_code) }, 'aria-hidden': 'true' }),
    el('span', { class: m.result === 'home' ? 'win' : '', text: teamShort(m.home_code) })
  ]));
  summary.appendChild(el('span', { class: 'score' }, [
    document.createTextNode(num(m.home_games) + ' – ' + num(m.away_games))
  ]));
  summary.appendChild(el('span', { class: 'side' }, [
    el('span', { class: 'chip', style: { background: teamColor(m.away_code) }, 'aria-hidden': 'true' }),
    el('span', { class: m.result === 'away' ? 'win' : '', text: teamShort(m.away_code) })
  ]));
  var bits = [];
  bits.push('sets ' + num(m.home_sets) + '–' + num(m.away_sets));
  bits.push('points ' + num(m.home_points, 1) + ' / ' + num(m.away_points, 1));
  if (m.status !== 'played') bits.push(m.status);
  if (m.tied_on_games) bits.push('tied on games, decided on sets');
  if ((m.warnings || []).length) bits.push((m.warnings || []).length + ' note' +
    ((m.warnings || []).length === 1 ? '' : 's'));
  summary.appendChild(el('span', { class: 'meta', text: bits.join(' · ') }));
  d.appendChild(summary);

  var body = el('div', { class: 'match-body' });
  body.appendChild(el('div', { class: 'table-wrap' }, [
    table(['Set', teamShort(m.home_code), 'G', 'G', teamShort(m.away_code), 'Status'],
      (m.sets || []).map(function (st) { return setRow(m, st); }),
      { caption: longDate(m.date) + ' · court ' + (m.court || '—') +
                 ' · match #' + m.id })
  ]));
  (m.fill_ins || []).forEach(function (slug) {
    body.appendChild(note('warning', 'Fill-in', playerName(slug) +
      ' played outside their registered roster.'));
  });
  (m.warnings || []).forEach(function (w) {
    body.appendChild(note('warning', 'Parse note', typeof w === 'string' ? w : (w.message || String(w))));
  });
  if (m.source) {
    body.appendChild(el('p', { class: 'foot muted', style: { 'font-size': '12px' },
      text: 'Source: ' + m.source }));
  }
  d.appendChild(body);
  return d;
}

function scheduledRow(fx) {
  var row = el('div', { class: 'match' });
  var line = el('div', { class: 'summary', style: { display: 'flex', 'flex-wrap': 'wrap',
    'align-items': 'center', gap: '6px 12px', padding: '10px 4px 10px 20px' } });
  line.appendChild(el('span', { class: 'side' }, [teamLinkByCode(fx.home_code)]));
  line.appendChild(el('span', { class: 'vs', text: 'v' }));
  line.appendChild(el('span', { class: 'side' }, [teamLinkByCode(fx.away_code)]));
  line.appendChild(el('span', { class: 'meta', text: 'scheduled · ' + longDate(fx.date) }));
  row.appendChild(line);
  return row;
}

/* ============================================================== view: home == */

function renderOverview(main) {
  var meta = S.meta || {};
  var ladder = IDX.ladder;
  var played = (S.matches || []).filter(function (m) { return m.status !== 'unplayed' && m.status !== 'bye'; });
  var totalFixtures = (S.fixtures || []).length;

  var setsPlayed = 0, gamesPlayed = 0, tightest = null, widest = null;
  played.forEach(function (m) {
    setsPlayed += (m.sets || []).filter(function (st) { return st.completed; }).length;
    gamesPlayed += (m.home_games || 0) + (m.away_games || 0);
    if (m.result === 'home' || m.result === 'away') {
      if (!tightest || m.margin < tightest.margin) tightest = m;
      if (!widest || m.margin > widest.margin) widest = m;
    }
  });
  var appeared = (S.players || []).filter(function (p) { return p.matches > 0; }).length;

  main.appendChild(el('div', { class: 'view-head' }, [
    el('h1', { text: 'Division ' + (meta.division || '?') + ' — ' + (meta.day || '') +
                     ' ' + (meta.season || '') }),
    el('p', { text: (meta.cards_ingested || 0) + ' scorecard' +
              ((meta.cards_ingested === 1) ? '' : 's') + ' read · ' +
              ladder.length + ' teams · ' + (S.players || []).length + ' registered players' })
  ]));

  // Hero: the one number the season leads with.
  var leader = ladder[0];
  var hero = el('div', { class: 'card hero' });
  hero.appendChild(el('div', { class: 'hero-figure' }, [
    el('div', { class: 'label', text: 'Ladder leader — points average' }),
    el('div', { class: 'value', text: leader && leader.points_average !== null
      ? num(leader.points_average, 2) : '—' }),
    el('div', { class: 'foot', text: leader
      ? leader.name + ' · ' + num(leader.points, 1) + ' points from ' +
        leader.played + ' ' + plural(leader.played, 'match', 'matches')
      : 'No results yet' })
  ]));
  var roundsPlayed = meta.rounds_played || 0;
  var roundsTotal = meta.rounds_total || 0;
  var progressPct = roundsTotal ? Math.round((roundsPlayed / roundsTotal) * 100) : 0;
  hero.appendChild(el('div', { class: 'progress' }, [
    el('div', { class: 'label' }, [
      el('span', { text: 'Season progress' }),
      el('span', { text: 'Round ' + roundsPlayed + ' of ' + roundsTotal })
    ]),
    el('div', { class: 'meter', role: 'img',
      'aria-label': roundsPlayed + ' of ' + roundsTotal + ' rounds played' }, [
      el('span', { style: { width: progressPct + '%' } })
    ]),
    el('div', { class: 'foot', text: played.length + ' of ' + totalFixtures +
      ' fixtures played · ' + progressPct + '% of the regular season' })
  ]));
  main.appendChild(hero);

  main.appendChild(el('div', { class: 'grid tiles', style: { 'margin-top': '12px' } }, [
    tile('Matches played', String(played.length), 'of ' + totalFixtures + ' scheduled'),
    tile('Sets completed', String(setsPlayed), SLOTS.join(' · ') + ' each round'),
    tile('Games played', String(gamesPlayed), played.length
      ? num(gamesPlayed / played.length, 1) + ' per match' : 'no matches yet'),
    tile('Tightest match', tightest ? num(tightest.margin) + ' game' +
      (tightest.margin === 1 ? '' : 's') : '—',
      tightest ? teamShort(tightest.home_code) + ' v ' + teamShort(tightest.away_code) +
        ', round ' + tightest.round : 'no decided matches'),
    tile('Biggest margin', widest ? num(widest.margin) + ' games' : '—',
      widest ? teamShort(widest.result === 'home' ? widest.home_code : widest.away_code) +
        ', round ' + widest.round : 'no decided matches'),
    tile('Players used', appeared + ' of ' + (S.players || []).length,
      (S.players || []).length - appeared + ' yet to play')
  ]));

  main.appendChild(sectionTitle('Ladder'));
  main.appendChild(el('div', { class: 'card' }, [ladderTable()]));

  var charts = el('div', { class: 'grid charts', style: { 'margin-top': '12px' } });
  charts.appendChild(pointsAverageChart(null));
  charts.appendChild(gamesForAgainstChart(null));
  charts.appendChild(ladderHistoryChart(null));
  charts.appendChild(el('div', { class: 'span-2' }, [h2hGridCard()]));
  main.appendChild(charts);

  main.appendChild(sectionTitle('Latest round'));
  var lastRound = (S.rounds || []).filter(function (r) { return r.played; }).pop();
  var box = el('div', { class: 'card' });
  if (!lastRound) {
    box.appendChild(el('p', { class: 'empty-note', text: 'No round has been played yet.' }));
  } else {
    box.appendChild(el('p', { class: 'sub muted', style: { margin: '0 0 4px' },
      text: 'Round ' + lastRound.number + ' · ' + longDate(lastRound.date) }));
    (lastRound.matches || []).forEach(function (id) {
      var m = IDX.matchById[id];
      if (m) box.appendChild(matchCard(m));
    });
  }
  main.appendChild(box);
}

function ladderTable() {
  var head = ['#', 'Team', 'P', 'W', 'L', 'D', 'Points',
    { label: 'Avg', title: 'Points average: points divided by matches counted' },
    { label: 'GF', title: 'Games for' }, { label: 'GA', title: 'Games against' },
    { label: 'Diff', title: 'Games differential' }, 'Form'];
  var rows = IDX.ladder.map(function (t) {
    return {
      href: '#/team/' + t.slug,
      cells: [
        { text: t.position === null || t.position === undefined ? '—' : t.position, cls: 'pos' },
        teamLink(t, { long: true }),
        t.played, t.won, t.lost, t.drawn,
        num(t.points, 1),
        t.points_average === null || t.points_average === undefined
          ? { text: '—', cls: 'muted' } : num(t.points_average, 2),
        t.games_won, t.games_lost, signed(t.games_diff),
        formRun(t.form)
      ]
    };
  });
  return el('div', { class: 'table-wrap' }, [
    table(head, rows, { caption: 'Ordered by points average. Select a row for the team page.' })
  ]);
}

/* ============================================================ team charts == */

function pointsAverageChart(selectedCode) {
  var rows = IDX.ladder.filter(function (t) {
    return t.points_average !== null && t.points_average !== undefined;
  }).map(function (t) {
    var isSel = selectedCode !== null && selectedCode !== undefined && t.code === selectedCode;
    return {
      label: t.short || t.name,
      value: t.points_average,
      valueText: num(t.points_average, 2),
      href: '#/team/' + t.slug,
      // Emphasis, not recolour-by-rank: one hue for the series, grey for context.
      color: selectedCode === null || selectedCode === undefined
        ? PAL.series[0] : (isSel ? teamColor(t.code) : PAL.deemph),
      dim: selectedCode !== null && selectedCode !== undefined && !isSel,
      tip: {
        title: t.name,
        rows: [
          { name: 'Points average', value: num(t.points_average, 2), kind: 'rect',
            color: isSel ? teamColor(t.code) : PAL.series[0] },
          { name: 'Points', value: num(t.points, 1) },
          { name: 'Played', value: String(t.played) },
          { name: 'Ladder position', value: String(t.position) }
        ]
      }
    };
  });
  return hbarCard({
    title: 'Points average by team',
    sub: selectedCode === null || selectedCode === undefined
      ? 'The measure the ladder is ordered on.'
      : 'The selected team in its own colour, the rest as context.',
    rows: rows,
    mode: 'single',
    axisLabel: 'Points average',
    empty: 'No team has a points average yet.',
    tableHead: ['Team', 'Points average', 'Points', 'Played'],
    tableCaption: 'Points average = points ÷ matches counted.',
    tableRow: function (r) {
      var t = IDX.teamBySlug[r.href.split('/').pop()];
      return [r.label, num(t.points_average, 2), num(t.points, 1), String(t.played)];
    }
  });
}

function gamesForAgainstChart(selectedCode) {
  var rows = IDX.ladder.map(function (t) {
    var isSel = selectedCode !== null && selectedCode !== undefined && t.code === selectedCode;
    var dim = selectedCode !== null && selectedCode !== undefined && !isSel;
    return {
      label: t.short || t.name,
      value: t.games_won, neg: t.games_lost,
      valueText: num(t.games_won), negText: num(t.games_lost),
      href: '#/team/' + t.slug,
      color: dim ? PAL.deemph : PAL.divPos,
      negColor: dim ? PAL.deemph : PAL.divNeg,
      dim: dim,
      aria: t.name + ': ' + t.games_won + ' games won, ' + t.games_lost + ' games lost',
      tip: {
        title: t.name,
        rows: [
          { name: 'Games won', value: num(t.games_won), kind: 'rect', color: PAL.divPos },
          { name: 'Games lost', value: num(t.games_lost), kind: 'rect', color: PAL.divNeg },
          { name: 'Differential', value: signed(t.games_diff) },
          { name: 'Sets', value: num(t.sets_won) + '–' + num(t.sets_lost) }
        ]
      }
    };
  });
  return hbarCard({
    title: 'Games for and against',
    sub: 'Won to the right, lost to the left, on one shared games axis.',
    rows: rows,
    mode: 'diverging',
    axisLabel: 'Games',
    integer: true,
    legend: legendBar([
      { name: 'Games won', color: PAL.divPos, kind: 'rect' },
      { name: 'Games lost', color: PAL.divNeg, kind: 'rect' }
    ]),
    empty: 'No games recorded yet.',
    tableHead: ['Team', 'Games won', 'Games lost', 'Differential', 'Sets won', 'Sets lost'],
    tableRow: function (r) {
      var t = IDX.teamBySlug[r.href.split('/').pop()];
      return [r.label, num(t.games_won), num(t.games_lost), signed(t.games_diff),
        num(t.sets_won), num(t.sets_lost)];
    }
  });
}

function ladderHistoryChart(selectedCode) {
  var xsSet = {};
  IDX.teamsOrdered.forEach(function (t) {
    (t.ladder_history || []).forEach(function (h) { xsSet[h.round] = true; });
  });
  var xs = Object.keys(xsSet).sort(function (a, b) { return roundOrder(a) - roundOrder(b); });
  var series = IDX.teamsOrdered.map(function (t) {
    var dim = selectedCode !== null && selectedCode !== undefined && t.code !== selectedCode;
    return {
      key: String(t.code),
      label: t.short || t.name,
      color: teamColor(t.code),
      dim: dim,
      points: (t.ladder_history || []).map(function (h) {
        return { x: h.round, y: h.position, avg: h.points_average };
      })
    };
  });
  return ladderLineCard({
    title: 'Ladder position by round',
    sub: 'One line per team, position 1 at the top.',
    xs: xs,
    series: series,
    empty: 'Positions appear once a round has been played.',
    tableCaption: 'Ladder position after each round.',
    valueText: function (pt) {
      return 'P' + pt.y + (pt.avg === null || pt.avg === undefined ? '' : ' · ' + num(pt.avg, 2));
    }
  });
}

function slotStrengthChart(t) {
  var rows = SLOTS.map(function (slot) {
    var rec = (t.by_slot || {})[slot] || { won: 0, lost: 0, games_won: 0, games_lost: 0 };
    return {
      label: slot,
      value: rec.games_won, neg: rec.games_lost,
      valueText: num(rec.games_won), negText: num(rec.games_lost),
      color: PAL.divPos, negColor: PAL.divNeg,
      aria: slot + ': ' + rec.games_won + ' games won, ' + rec.games_lost + ' lost, record ' +
        rec.won + '–' + rec.lost,
      tip: {
        title: slotLabel(slot),
        rows: [
          { name: 'Games won', value: num(rec.games_won), kind: 'rect', color: PAL.divPos },
          { name: 'Games lost', value: num(rec.games_lost), kind: 'rect', color: PAL.divNeg },
          { name: 'Sets', value: rec.won + '–' + rec.lost }
        ]
      }
    };
  });
  return hbarCard({
    title: 'Strength by set slot',
    sub: 'Which of the four sets this team actually wins.',
    rows: rows,
    mode: 'diverging',
    axisLabel: 'Games',
    integer: true,
    legend: legendBar([
      { name: 'Games won', color: PAL.divPos, kind: 'rect' },
      { name: 'Games lost', color: PAL.divNeg, kind: 'rect' }
    ]),
    empty: 'No sets played yet.',
    tableHead: ['Slot', 'Sets won', 'Sets lost', 'Games won', 'Games lost'],
    tableRow: function (r) {
      var rec = (t.by_slot || {})[r.label] || {};
      return [slotLabel(r.label), num(rec.won), num(rec.lost),
        num(rec.games_won), num(rec.games_lost)];
    }
  });
}

function slotLabel(slot) {
  return slot === 'D1' ? 'D1 — Doubles 1'
    : slot === 'S1' ? 'S1 — Singles P1'
    : slot === 'S2' ? 'S2 — Singles P2'
    : slot === 'D2' ? 'D2 — Doubles 2 (repeat)'
    : slot;
}

function pointsByRoundChart(t, matches) {
  var rows = matches.map(function (m) {
    var isHome = m.home_code === t.code;
    var pts = isHome ? m.home_points : m.away_points;
    var mine = isHome ? m.home_games : m.away_games;
    var theirs = isHome ? m.away_games : m.home_games;
    var oppCode = isHome ? m.away_code : m.home_code;
    return {
      label: 'R' + m.round,
      value: pts === null || pts === undefined ? 0 : pts,
      valueText: pts === null || pts === undefined ? 'averaged' : num(pts, 1),
      color: PAL.series[0],
      aria: 'Round ' + m.round + ': ' + num(pts, 1) + ' points against ' + teamName(oppCode),
      tip: {
        title: 'Round ' + m.round + ' v ' + teamShort(oppCode),
        rows: [
          { name: 'Points', value: num(pts, 1), kind: 'rect', color: PAL.series[0] },
          { name: 'Games', value: num(mine) + '–' + num(theirs) },
          { name: 'Result', value: resultWord(m, t.code) },
          { name: isHome ? 'At home' : 'Away', value: longDate(m.date) }
        ]
      }
    };
  });
  return hbarCard({
    title: 'Points earned by round',
    sub: '4 for a win, 2 for a loss, 3 for a draw, plus 0.1 a game.',
    rows: rows,
    mode: 'single',
    axisLabel: 'Competition points',
    empty: 'This team has not played yet.',
    tableHead: ['Round', 'Opponent', 'Result', 'Games', 'Points'],
    tableRow: function (r) {
      var m = matches[rows.indexOf(r)];
      var isHome = m.home_code === t.code;
      return ['R' + m.round, teamShort(isHome ? m.away_code : m.home_code),
        resultWord(m, t.code),
        num(isHome ? m.home_games : m.away_games) + '–' +
        num(isHome ? m.away_games : m.home_games),
        num(isHome ? m.home_points : m.away_points, 1)];
    }
  });
}

function resultWord(m, code) {
  if (m.result === 'draw') return 'Draw';
  if (m.result === 'none' || !m.result) return m.status || 'Not played';
  var won = (m.result === 'home' && m.home_code === code) ||
            (m.result === 'away' && m.away_code === code);
  return won ? 'Win' : 'Loss';
}

/* ============================================================== view: team == */

function renderTeam(main, slug) {
  var t = IDX.teamBySlug[slug];
  if (!t) { renderMissing(main, 'No team with the id "' + slug + '".'); return; }
  var matches = matchesOfTeam(t.code);
  document.title = t.name + ' — Division ' + (S.meta || {}).division;

  main.appendChild(el('a', { class: 'crumb', href: '#/', text: '← Ladder' }));
  main.appendChild(el('div', { class: 'view-head' }, [
    el('h1', {}, [
      el('span', { class: 'chip', 'aria-hidden': 'true',
        style: { background: teamColor(t.code), display: 'inline-block',
                 width: '12px', height: '12px', 'border-radius': '3px',
                 'margin-right': '8px' } }),
      document.createTextNode(t.name)
    ]),
    el('p', { text: 'Draw code ' + t.code + ' · captain ' + (t.captain || '—') +
      ' · home court ' + (t.home_court === null || t.home_court === undefined
        ? '—' : t.home_court) })
  ]));

  var pos = t.position === null || t.position === undefined ? '—' : String(t.position);
  main.appendChild(el('div', { class: 'grid tiles' }, [
    tile('Ladder position', pos, t.played
      ? num(t.points_average, 2) + ' points average' : 'no matches counted'),
    tile('Record', t.won + '–' + t.lost + (t.drawn ? '–' + t.drawn : ''),
      t.played + ' ' + plural(t.played, 'match', 'matches') + ' played'),
    tile('Points', num(t.points, 1),
      (t.points_breakdown && t.points_breakdown.averaged_matches
        ? num(t.points_breakdown.earned, 1) + ' earned + ' +
          num(t.points_breakdown.averaged, 1) + ' averaged'
        : 'all earned on court')),
    tile('Games', num(t.games_won) + '–' + num(t.games_lost),
      signed(t.games_diff) + ' differential'),
    tile('Sets', num(t.sets_won) + '–' + num(t.sets_lost),
      (t.sets_won + t.sets_lost) ? num(100 * t.sets_won / (t.sets_won + t.sets_lost), 0) +
        '% of sets won' : 'no sets yet'),
    tile('Streak', streakWords(t.streak),
      'best round ' + (t.best_round ? 'R' + t.best_round.round + ' (' +
        num(t.best_round.points, 1) + ')' : '—'))
  ]));

  var splitBox = el('div', { class: 'card' }, [
    el('div', { class: 'table-wrap' }, [
      table(['Split', 'P', 'W', 'L', 'D', 'GF', 'GA', 'Diff'], [
        ['Home', t.home.played, t.home.won, t.home.lost, t.home.drawn,
          t.home.games_won, t.home.games_lost, signed(t.home.games_won - t.home.games_lost)],
        ['Away', t.away.played, t.away.won, t.away.lost, t.away.drawn,
          t.away.games_won, t.away.games_lost, signed(t.away.games_won - t.away.games_lost)],
        ['Total', t.played, t.won, t.lost, t.drawn, t.games_won, t.games_lost, signed(t.games_diff)]
      ], { caption: 'Home and away split' })
    ]),
    el('p', { class: 'foot muted', style: { 'font-size': '12px', margin: '8px 0 0' } }, [
      document.createTextNode('Form (oldest first): '), formRun(t.form)
    ])
  ]);

  var charts = el('div', { class: 'grid charts', style: { 'margin-top': '12px' } });
  charts.appendChild(slotStrengthChart(t));
  charts.appendChild(pointsByRoundChart(t, matches));
  charts.appendChild(ladderHistoryChart(t.code));
  charts.appendChild(pointsAverageChart(t.code));

  main.appendChild(sectionTitle('Splits'));
  main.appendChild(splitBox);
  main.appendChild(charts);

  main.appendChild(sectionTitle('Players'));
  main.appendChild(el('div', { class: 'card' }, [teamPlayersTable(t)]));

  main.appendChild(sectionTitle('Head to head'));
  main.appendChild(el('div', { class: 'card' }, [teamH2HTable(t)]));

  main.appendChild(sectionTitle('Matches'));
  var box = el('div', { class: 'card' });
  if (!matches.length) {
    box.appendChild(el('p', { class: 'empty-note',
      text: 'No matches played yet. Upcoming fixtures are on the Matches page.' }));
  } else {
    matches.forEach(function (m) { box.appendChild(matchCard(m)); });
  }
  var upcoming = (S.fixtures || []).filter(function (f) {
    return !f.played && (f.home_code === t.code || f.away_code === t.code);
  });
  if (upcoming.length) {
    box.appendChild(el('p', { class: 'foot muted', style: { 'font-size': '12px', 'margin-top': '10px' },
      text: upcoming.length + ' fixture' + (upcoming.length === 1 ? '' : 's') + ' still to play, ' +
        'next: round ' + upcoming[0].round + ' v ' +
        teamShort(upcoming[0].home_code === t.code ? upcoming[0].away_code : upcoming[0].home_code) +
        ' on ' + longDate(upcoming[0].date) }));
  }
  main.appendChild(box);
}

function teamPlayersTable(t) {
  var roster = (t.players || []).map(function (slug) { return IDX.playerBySlug[slug]; })
    .filter(Boolean);
  if (!roster.length) {
    return el('p', { class: 'empty-note', text: 'No registered players recorded for this team.' });
  }
  var rows = roster.map(function (p) {
    return {
      href: '#/player/' + p.slug,
      cells: [
        playerLink(p.slug),
        p.is_captain ? 'C' : { text: '—', cls: 'muted' },
        p.matches, p.sets_played,
        p.sets_won + '–' + p.sets_lost,
        p.win_pct === null || p.win_pct === undefined ? { text: '—', cls: 'muted' } : pct(p.win_pct),
        num(p.games_won), num(p.games_lost), signed(p.games_diff),
        p.contribution ? pct(p.contribution.share_pct) : '—',
        p.rating && p.rating.singles !== null ? num(p.rating.singles, 2) : { text: '—', cls: 'muted' },
        p.rating && p.rating.doubles !== null ? num(p.rating.doubles, 2) : { text: '—', cls: 'muted' }
      ]
    };
  });
  return el('div', { class: 'table-wrap' }, [
    table(['Player', { label: 'C', title: 'Captain' }, 'M', 'Sets', 'W–L', 'Win %',
      'GF', 'GA', 'Diff',
      { label: 'Share', title: 'Share of the team’s games won' },
      { label: 'S', title: 'Singles rating' }, { label: 'D', title: 'Doubles rating' }],
      rows, { caption: 'Contribution of each registered player.' })
  ]);
}

function teamH2HTable(t) {
  var others = IDX.teamsOrdered.filter(function (o) { return o.code !== t.code; });
  var rows = others.map(function (o) {
    var rec = h2hFor(t.code, o.code);
    var scheduled = (S.fixtures || []).filter(function (f) {
      return !f.played && ((f.home_code === t.code && f.away_code === o.code) ||
        (f.home_code === o.code && f.away_code === t.code));
    });
    return {
      href: '#/team/' + o.slug,
      cells: [
        teamLink(o, { long: true }),
        rec ? rec.played : 0,
        rec ? rec.won + '–' + rec.lost + (rec.drawn ? '–' + rec.drawn : '') : { text: '—', cls: 'muted' },
        rec ? num(rec.gamesFor) + '–' + num(rec.gamesAgainst) : { text: '—', cls: 'muted' },
        rec ? signed(rec.gamesFor - rec.gamesAgainst) : { text: '—', cls: 'muted' },
        scheduled.length ? 'R' + scheduled.map(function (f) { return f.round; }).join(', R')
          : { text: '—', cls: 'muted' }
      ]
    };
  });
  return el('div', { class: 'table-wrap' }, [
    table(['Opponent', 'Met', 'W–L', 'Games', 'Diff',
      { label: 'To come', title: 'Rounds where this fixture is still to be played' }],
      rows, { caption: 'Record against each other team in the division.' })
  ]);
}

/* ============================================================ view: player == */

function renderPlayer(main, slug) {
  var p = IDX.playerBySlug[slug];
  if (!p) { renderMissing(main, 'No player with the id "' + slug + '".'); return; }
  var team = teamOf(p.team_code);
  var sets = setsOfPlayer(p.slug);
  document.title = p.name + ' — Division ' + (S.meta || {}).division;

  main.appendChild(el('a', { class: 'crumb', href: '#/players', text: '← All players' }));
  main.appendChild(el('div', { class: 'view-head' }, [
    el('h1', { text: p.name + (p.is_captain ? ' (captain)' : '') }),
    el('p', {}, [
      team ? teamLink(team, { long: true }) : document.createTextNode(p.team || ''),
      document.createTextNode(' · rating ' +
        (p.rating && p.rating.singles !== null ? num(p.rating.singles, 2) : '—') + ' singles / ' +
        (p.rating && p.rating.doubles !== null ? num(p.rating.doubles, 2) : '—') + ' doubles')
    ])
  ]));

  if (!p.matches) {
    main.appendChild(note('warning', 'No appearances yet',
      p.name + ' is registered for ' + (p.team || 'the team') +
      ' but has not played a set so far. Everything below will fill in once they do.'));
  }

  var streakWord = p.streak && p.streak.length
    ? p.streak.length + ' ' + (p.streak.type === 'W' ? 'won' : p.streak.type === 'L' ? 'lost' : 'drawn')
    : '—';
  main.appendChild(el('div', { class: 'grid tiles' }, [
    tile('Matches', String(p.matches), 'of ' + p.available + ' the team has played'),
    tile('Sets', p.sets_won + '–' + p.sets_lost, p.sets_played + ' played'),
    tile('Win rate', p.win_pct === null || p.win_pct === undefined ? '—' : pct(p.win_pct),
      'of completed sets'),
    tile('Games', num(p.games_won) + '–' + num(p.games_lost),
      signed(p.games_diff) + ' differential'),
    tile('Set streak', streakWord, 'longest win run ' + num(p.longest_win_streak)),
    tile('Team share', p.contribution ? pct(p.contribution.share_pct) : '—',
      p.contribution ? num(p.contribution.games_won) + ' of ' +
        num(p.contribution.team_games_won) + ' team games won' : '—')
  ]));

  var charts = el('div', { class: 'grid charts', style: { 'margin-top': '12px' } });
  charts.appendChild(disciplineChart(p));
  charts.appendChild(opponentDiffChart(p));
  main.appendChild(charts);

  main.appendChild(sectionTitle('Where they play'));
  main.appendChild(el('div', { class: 'card' }, [slotAppearanceTable(p)]));

  main.appendChild(sectionTitle('Doubles partners'));
  main.appendChild(el('div', { class: 'card' }, [pairTable(p.partners, 'partner',
    'No doubles set played yet.')]));

  main.appendChild(sectionTitle('Opponents'));
  main.appendChild(el('div', { class: 'card' }, [pairTable(p.opponents, 'opponent',
    'No opponent faced yet.')]));

  if ((p.rating_history || []).length > 1) {
    main.appendChild(sectionTitle('Rating as printed each round'));
    main.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'table-wrap' }, [
        table(['Round', 'Singles', 'Doubles'], (p.rating_history || []).map(function (h) {
          return ['R' + h.round,
            h.singles === null || h.singles === undefined ? { text: '—', cls: 'muted' } : num(h.singles, 2),
            h.doubles === null || h.doubles === undefined ? { text: '—', cls: 'muted' } : num(h.doubles, 2)];
        }), { caption: 'Ratings come off the scorecard, so a mid-season change shows up here.' })
      ])
    ]));
  }

  main.appendChild(sectionTitle('Every set played'));
  var box = el('div', { class: 'card' });
  if (!sets.length) {
    box.appendChild(el('p', { class: 'empty-note', text: 'No sets recorded yet.' }));
  } else {
    var rows = sets.map(function (s) {
      var withNode = el('span');
      if (s.partners.length) {
        s.partners.forEach(function (pl, i) {
          if (i) withNode.appendChild(document.createTextNode(' + '));
          withNode.appendChild(playerLink(pl));
        });
      } else {
        withNode.appendChild(el('span', { class: 'muted', text: '—' }));
      }
      var vsNode = el('span');
      s.opponents.forEach(function (pl, i) {
        if (i) vsNode.appendChild(document.createTextNode(' + '));
        vsNode.appendChild(playerLink(pl));
      });
      return [
        'R' + s.match.round,
        teamLinkByCode(s.opponentTeam),
        s.set.slot,
        withNode,
        vsNode,
        num(s.gamesFor) + '–' + num(s.gamesAgainst),
        { text: s.decided ? (s.won ? 'Won' : 'Lost') : (s.set.status || 'unfinished'),
          cls: s.decided ? (s.won ? 'win' : 'lose') : 'muted' }
      ];
    });
    box.appendChild(el('div', { class: 'table-wrap' }, [
      table(['Round', 'Opponent team', 'Slot', 'With', 'Against', 'Games', 'Result'], rows,
        { caption: 'Derived from the set rows on each scorecard.' })
    ]));
  }
  main.appendChild(box);
}

function disciplineChart(p) {
  var defs = [
    { key: 'singles', label: 'Singles', rec: p.singles || {} },
    { key: 'doubles', label: 'Doubles', rec: p.doubles || {} }
  ];
  var rows = defs.map(function (d) {
    return {
      label: d.label,
      value: d.rec.games_won || 0, neg: d.rec.games_lost || 0,
      valueText: num(d.rec.games_won || 0), negText: num(d.rec.games_lost || 0),
      color: PAL.divPos, negColor: PAL.divNeg,
      aria: d.label + ': ' + (d.rec.games_won || 0) + ' games won, ' +
        (d.rec.games_lost || 0) + ' lost',
      tip: {
        title: d.label,
        rows: [
          { name: 'Games won', value: num(d.rec.games_won || 0), kind: 'rect', color: PAL.divPos },
          { name: 'Games lost', value: num(d.rec.games_lost || 0), kind: 'rect', color: PAL.divNeg },
          { name: 'Sets', value: (d.rec.won || 0) + '–' + (d.rec.lost || 0) },
          { name: 'Sets played', value: num(d.rec.played || 0) }
        ]
      }
    };
  });
  return hbarCard({
    title: 'Singles and doubles',
    sub: 'Games won and lost in each discipline.',
    rows: rows,
    mode: 'diverging',
    axisLabel: 'Games',
    integer: true,
    legend: legendBar([
      { name: 'Games won', color: PAL.divPos, kind: 'rect' },
      { name: 'Games lost', color: PAL.divNeg, kind: 'rect' }
    ]),
    empty: 'No sets played yet.',
    tableHead: ['Discipline', 'Sets played', 'Won', 'Lost', 'Games won', 'Games lost'],
    tableRow: function (r) {
      var d = defs[rows.indexOf(r)];
      return [d.label, num(d.rec.played || 0), num(d.rec.won || 0), num(d.rec.lost || 0),
        num(d.rec.games_won || 0), num(d.rec.games_lost || 0)];
    }
  });
}

function opponentDiffChart(p) {
  var list = (p.opponents || []).slice().sort(function (a, b) {
    return (b.games_won - b.games_lost) - (a.games_won - a.games_lost);
  });
  var rows = list.map(function (o) {
    var diff = o.games_won - o.games_lost;
    return {
      label: o.name,
      value: diff > 0 ? diff : 0,
      neg: diff < 0 ? -diff : 0,
      valueText: diff > 0 ? signed(diff) : '',
      negText: diff < 0 ? signed(diff) : (diff === 0 ? '0' : ''),
      color: PAL.divPos, negColor: PAL.divNeg,
      href: '#/player/' + o.slug,
      aria: o.name + ': games differential ' + signed(diff),
      tip: {
        title: o.name,
        rows: [
          { name: 'Games differential', value: signed(diff), kind: 'rect',
            color: diff < 0 ? PAL.divNeg : PAL.divPos },
          { name: 'Games', value: num(o.games_won) + '–' + num(o.games_lost) },
          { name: 'Sets', value: o.won + '–' + o.lost },
          { name: 'Sets met', value: num(o.sets) }
        ]
      }
    };
  });
  return hbarCard({
    title: 'Games differential by opponent',
    sub: 'Above the line to the right, behind to the left.',
    rows: rows,
    mode: 'diverging',
    axisLabel: 'Games differential',
    integer: true,
    legend: legendBar([
      { name: 'Ahead', color: PAL.divPos, kind: 'rect' },
      { name: 'Behind', color: PAL.divNeg, kind: 'rect' }
    ]),
    empty: 'No opponent faced yet.',
    tableHead: ['Opponent', 'Sets met', 'W–L', 'Games won', 'Games lost', 'Diff'],
    tableRow: function (r) {
      var o = list[rows.indexOf(r)];
      return [o.name, num(o.sets), o.won + '–' + o.lost, num(o.games_won),
        num(o.games_lost), signed(o.games_won - o.games_lost)];
    }
  });
}

function slotAppearanceTable(p) {
  var rows = SLOTS.map(function (slot) {
    var rec = (p.by_slot || {})[slot] || { played: 0, won: 0 };
    return [slotLabel(slot), num(rec.played), num(rec.won),
      rec.played ? pct(100 * rec.won / rec.played) : { text: '—', cls: 'muted' }];
  });
  var out = el('div');
  out.appendChild(el('div', { class: 'table-wrap' }, [
    table(['Slot', 'Played', 'Won', 'Win rate'], rows,
      { caption: 'Which of the four set slots this player is used in.' })
  ]));
  if (p.fill_in_appearances) {
    out.appendChild(note('warning', 'Fill-in', p.name + ' has played ' +
      p.fill_in_appearances + ' set' + (p.fill_in_appearances === 1 ? '' : 's') +
      ' outside their registered roster.'));
  }
  return out;
}

function pairTable(list, kind, emptyText) {
  if (!list || !list.length) return el('p', { class: 'empty-note', text: emptyText });
  var rows = list.slice().sort(function (a, b) { return b.sets - a.sets; }).map(function (r) {
    return {
      href: '#/player/' + r.slug,
      cells: [playerLink(r.slug), num(r.sets), r.won + '–' + r.lost,
        num(r.games_won), num(r.games_lost), signed(r.games_won - r.games_lost)]
    };
  });
  return el('div', { class: 'table-wrap' }, [
    table([kind === 'partner' ? 'Partner' : 'Opponent', 'Sets', 'W–L', 'GF', 'GA', 'Diff'],
      rows, { caption: kind === 'partner'
        ? 'Record in doubles sets played together.'
        : 'Record in every set contested against this player.' })
  ]);
}

/* =========================================================== view: matches == */

function renderMatches(main) {
  document.title = 'Matches — Division ' + (S.meta || {}).division;
  main.appendChild(el('div', { class: 'view-head' }, [
    el('h1', { text: 'Matches' }),
    el('p', { text: 'Every fixture in the draw. Played matches expand to the four set scores; ' +
      'the rest are shown as scheduled.' })
  ]));

  var rounds = (S.rounds || []).slice().sort(function (a, b) {
    return roundOrder(a.number) - roundOrder(b.number);
  });
  if (!rounds.length) {
    main.appendChild(el('p', { class: 'empty-note', text: 'No rounds in the draw.' }));
    return;
  }
  rounds.forEach(function (r) {
    var fixtures = (S.fixtures || []).filter(function (f) { return f.round === r.number; });
    var head = el('div', { class: 'round-head' }, [
      el('h3', { text: r.is_finals ? 'Finals & play-offs' : 'Round ' + r.number }),
      el('span', { class: 'date', text: longDate(r.date) }),
      el('span', { class: 'pill ' + (r.played ? 'good' : '') }, [
        el('span', { class: 'dot', 'aria-hidden': 'true' }),
        el('span', { text: r.played ? 'played' : 'not played yet' })
      ])
    ]);
    main.appendChild(head);
    var box = el('div', { class: 'card' });
    if (!fixtures.length && !(r.matches || []).length) {
      box.appendChild(el('p', { class: 'empty-note',
        text: r.is_finals
          ? 'Pairings are set by ladder position once round 10 is in.'
          : 'No fixtures listed for this round.' }));
    }
    fixtures.forEach(function (f) {
      var m = f.match_id ? IDX.matchById[f.match_id] : null;
      if (m) box.appendChild(matchCard(m));
      else box.appendChild(scheduledRow(f));
    });
    // A card whose match id is not in any fixture still gets shown.
    (r.matches || []).forEach(function (id) {
      var known = fixtures.some(function (f) { return f.match_id === id; });
      if (!known && IDX.matchById[id]) box.appendChild(matchCard(IDX.matchById[id]));
    });
    main.appendChild(box);
  });
}

/* =========================================================== view: players == */

var PLAYER_COLS = [
  { key: 'name', label: 'Player', type: 'text' },
  { key: 'team', label: 'Team', type: 'text' },
  { key: 'matches', label: 'M', type: 'num', title: 'Matches played' },
  { key: 'sets_played', label: 'Sets', type: 'num' },
  { key: 'sets_won', label: 'Won', type: 'num' },
  { key: 'win_pct', label: 'Win %', type: 'num' },
  { key: 'games_won', label: 'GF', type: 'num', title: 'Games won' },
  { key: 'games_lost', label: 'GA', type: 'num', title: 'Games lost' },
  { key: 'games_diff', label: 'Diff', type: 'num' },
  { key: 'singles_pct', label: 'S W-L', type: 'text', title: 'Singles record' },
  { key: 'doubles_pct', label: 'D W-L', type: 'text', title: 'Doubles record' },
  { key: 'share', label: 'Share', type: 'num', title: 'Share of team games won' },
  { key: 'rating_s', label: 'S rating', type: 'num' },
  { key: 'rating_d', label: 'D rating', type: 'num' }
];

function playerSortValue(p, key) {
  switch (key) {
    case 'name': return p.name;
    case 'team': return p.team || '';
    case 'win_pct': return p.win_pct === null || p.win_pct === undefined ? -1 : p.win_pct;
    case 'share': return p.contribution ? p.contribution.share_pct : -1;
    case 'rating_s': return p.rating && p.rating.singles !== null ? p.rating.singles : -1;
    case 'rating_d': return p.rating && p.rating.doubles !== null ? p.rating.doubles : -1;
    case 'singles_pct': return (p.singles || {}).won || 0;
    case 'doubles_pct': return (p.doubles || {}).won || 0;
    default: return p[key] === null || p[key] === undefined ? -1 : p[key];
  }
}

function renderPlayers(main) {
  document.title = 'Players — Division ' + (S.meta || {}).division;
  main.appendChild(el('div', { class: 'view-head' }, [
    el('h1', { text: 'Players' }),
    el('p', { text: 'Every registered player in the division, including those yet to play. ' +
      'Select a column heading to sort.' })
  ]));

  var players = (S.players || []).slice();
  var wrap = el('div', { class: 'card' });
  var host = el('div');
  wrap.appendChild(host);
  main.appendChild(wrap);
  drawPlayerTable();

  main.appendChild(sectionTitle('Games differential'));
  var chartHost = el('div', { class: 'grid charts' });
  chartHost.appendChild(playerDiffChart(players));
  main.appendChild(chartHost);

  function drawPlayerTable() {
    clear(host);
    var sorted = players.slice().sort(function (a, b) {
      var va = playerSortValue(a, PLAYER_SORT.key), vb = playerSortValue(b, PLAYER_SORT.key);
      var cmp = typeof va === 'string'
        ? String(va).localeCompare(String(vb))
        : (va - vb);
      if (cmp === 0) return String(a.name).localeCompare(String(b.name));
      return cmp * PLAYER_SORT.dir;
    });
    var head = PLAYER_COLS.map(function (c) {
      var active = PLAYER_SORT.key === c.key;
      return {
        label: c.label, sortable: true, title: c.title,
        arrow: active ? (PLAYER_SORT.dir === 1 ? '▲' : '▼') : '',
        ariaSort: active ? (PLAYER_SORT.dir === 1 ? 'ascending' : 'descending') : 'none',
        onSort: function () {
          if (PLAYER_SORT.key === c.key) PLAYER_SORT.dir = -PLAYER_SORT.dir;
          else PLAYER_SORT = { key: c.key, dir: c.type === 'text' ? 1 : -1 };
          drawPlayerTable();
        }
      };
    });
    var rows = sorted.map(function (p) {
      var s = p.singles || {}, d = p.doubles || {};
      return {
        href: '#/player/' + p.slug,
        cells: [
          playerLink(p.slug),
          teamLinkByCode(p.team_code),
          p.matches, p.sets_played, p.sets_won,
          p.win_pct === null || p.win_pct === undefined ? { text: '—', cls: 'muted' } : pct(p.win_pct),
          num(p.games_won), num(p.games_lost), signed(p.games_diff),
          (s.won || 0) + '–' + (s.lost || 0),
          (d.won || 0) + '–' + (d.lost || 0),
          p.contribution ? pct(p.contribution.share_pct) : { text: '—', cls: 'muted' },
          p.rating && p.rating.singles !== null ? num(p.rating.singles, 2) : { text: '—', cls: 'muted' },
          p.rating && p.rating.doubles !== null ? num(p.rating.doubles, 2) : { text: '—', cls: 'muted' }
        ]
      };
    });
    host.appendChild(el('div', { class: 'table-wrap' }, [
      table(head, rows, { caption: (S.players || []).length + ' registered players. ' +
        'A dash means nothing recorded yet.' })
    ]));
  }
}

function playerDiffChart(players) {
  var list = players.filter(function (p) { return p.sets_played > 0; })
    .slice().sort(function (a, b) { return b.games_diff - a.games_diff; });
  var rows = list.map(function (p) {
    var diff = p.games_diff;
    return {
      label: p.name,
      value: diff > 0 ? diff : 0,
      neg: diff < 0 ? -diff : 0,
      valueText: diff > 0 ? signed(diff) : '',
      negText: diff < 0 ? signed(diff) : (diff === 0 ? '0' : ''),
      color: PAL.divPos, negColor: PAL.divNeg,
      href: '#/player/' + p.slug,
      aria: p.name + ': games differential ' + signed(diff),
      tip: {
        title: p.name,
        rows: [
          { name: 'Games differential', value: signed(diff), kind: 'rect',
            color: diff < 0 ? PAL.divNeg : PAL.divPos },
          { name: 'Games', value: num(p.games_won) + '–' + num(p.games_lost) },
          { name: 'Sets', value: p.sets_won + '–' + p.sets_lost },
          { name: 'Team', value: p.team || '' }
        ]
      }
    };
  });
  return hbarCard({
    title: 'Games differential by player',
    sub: 'Everyone who has played a set, best to worst.',
    rows: rows,
    mode: 'diverging',
    axisLabel: 'Games won minus games lost',
    integer: true,
    legend: legendBar([
      { name: 'Ahead', color: PAL.divPos, kind: 'rect' },
      { name: 'Behind', color: PAL.divNeg, kind: 'rect' }
    ]),
    empty: 'Nobody has played a set yet.',
    tableHead: ['Player', 'Team', 'Games won', 'Games lost', 'Diff'],
    tableRow: function (r) {
      var p = list[rows.indexOf(r)];
      return [p.name, p.team || '', num(p.games_won), num(p.games_lost), signed(p.games_diff)];
    }
  });
}

/* ============================================================ data health == */

function renderHealth() {
  var host = document.getElementById('health');
  clear(host);
  var v = (S && S.validation) || { ok: true, errors: [], warnings: [] };
  var errors = v.errors || [], warnings = v.warnings || [];
  var row = el('div', { class: 'health-row' });

  var state = errors.length ? 'critical' : warnings.length ? 'warning' : 'good';
  var label = errors.length
    ? errors.length + ' validation ' + plural(errors.length, 'error')
    : warnings.length
      ? 'Validated with ' + warnings.length + ' ' + plural(warnings.length, 'warning')
      : 'Validated clean';
  row.appendChild(el('span', { class: 'pill ' + state }, [
    el('span', { class: 'dot', 'aria-hidden': 'true' }),
    el('span', { text: (errors.length ? '✕ ' : warnings.length ? '! ' : '✓ ') + label })
  ]));
  row.appendChild(el('span', { class: 'pill' }, [
    el('span', { class: 'dot', 'aria-hidden': 'true' }),
    el('span', { text: ((S.meta || {}).cards_ingested || 0) + ' cards read' })
  ]));
  var mismatched = (S.matches || []).filter(function (m) { return (m.warnings || []).length; }).length;
  if (mismatched) {
    row.appendChild(el('span', { class: 'pill warning' }, [
      el('span', { class: 'dot', 'aria-hidden': 'true' }),
      el('span', { text: mismatched + ' ' + plural(mismatched, 'match', 'matches') + ' with parse notes' })
    ]));
  }
  row.appendChild(el('span', { class: 'muted', text: SOURCE_NOTE }));
  host.appendChild(row);

  if (errors.length || warnings.length) {
    var det = el('details');
    if (errors.length) det.setAttribute('open', '');
    det.appendChild(el('summary', { text: 'Data health detail (' + errors.length + ' ' +
      plural(errors.length, 'error') + ', ' + warnings.length + ' ' +
      plural(warnings.length, 'warning') + ')' }));
    var list = el('ul');
    errors.concat(warnings).forEach(function (item, i) {
      var isError = i < errors.length;
      var li = el('li');
      li.appendChild(el('strong', { text: (isError ? 'Error' : 'Warning') +
        (item.code ? ' · ' + item.code : '') + ': ' }));
      li.appendChild(document.createTextNode(item.message || String(item)));
      if (item.source) li.appendChild(el('code', { text: ' [' + item.source + ']' }));
      list.appendChild(li);
    });
    det.appendChild(list);
    host.appendChild(det);
  }
}

/* ================================================================= router == */

function renderMissing(main, message) {
  main.appendChild(el('div', { class: 'view-head' }, [
    el('h1', { text: 'Not found' }),
    el('p', { text: message })
  ]));
  main.appendChild(el('div', { class: 'card' }, [
    el('p', { class: 'empty-note', text: 'Try the ladder, the matches or the player list.' })
  ]));
}

function parseRoute() {
  var hash = location.hash.replace(/^#\/?/, '');
  var parts = hash.split('/').filter(function (s) { return s.length; });
  if (!parts.length) return { view: 'overview' };
  if (parts[0] === 'team') return { view: 'team', slug: decodeURIComponent(parts[1] || '') };
  if (parts[0] === 'player') return { view: 'player', slug: decodeURIComponent(parts[1] || '') };
  if (parts[0] === 'matches') return { view: 'matches' };
  if (parts[0] === 'players') return { view: 'players' };
  return { view: 'overview' };
}

function markTabs(route) {
  var map = { overview: '#/', matches: '#/matches', players: '#/players' };
  var want = map[route.view] || '';
  Array.prototype.forEach.call(document.querySelectorAll('.tabs a'), function (a) {
    if (a.getAttribute('href') === want) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  var picker = document.getElementById('entity-picker');
  if (picker) {
    picker.value = route.view === 'team' ? 'team:' + route.slug
      : route.view === 'player' ? 'player:' + route.slug : '';
  }
}

function render() {
  var main = document.getElementById('view');
  CHARTS = [];
  clear(main);
  hideTip();
  readPalette();
  var route = parseRoute();
  var meta = S.meta || {};
  document.title = 'Division ' + (meta.division || '') + ' ' + (meta.day || '') + ' — dashboard';
  if (route.view === 'team') renderTeam(main, route.slug);
  else if (route.view === 'player') renderPlayer(main, route.slug);
  else if (route.view === 'matches') renderMatches(main);
  else if (route.view === 'players') renderPlayers(main);
  else renderOverview(main);
  markTabs(route);
  drawCharts();
  window.scrollTo(0, 0);
}

function drawCharts() {
  CHARTS.forEach(function (c) {
    var w = c.plot.clientWidth || c.figure.clientWidth || 600;
    c.draw(c.plot, Math.max(240, Math.floor(w)));
  });
}

var resizeTimer = null;
function onResize() {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function () { readPalette(); drawCharts(); }, 150);
}

/* ================================================================== theme == */

function applyTheme(mode) {
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  try { localStorage.setItem('uqtc-theme', mode); } catch (e) { /* file:// or private mode */ }
  var btn = document.getElementById('theme-toggle');
  if (btn) {
    var label = mode === 'system' ? 'Theme: system' : mode === 'dark' ? 'Theme: dark' : 'Theme: light';
    btn.textContent = label;
    btn.setAttribute('aria-label', label + '. Select to change.');
  }
  readPalette();
  drawCharts();
}

function initTheme() {
  var stored = null;
  try { stored = localStorage.getItem('uqtc-theme'); } catch (e) { stored = null; }
  var order = ['system', 'light', 'dark'];
  var current = order.indexOf(stored) >= 0 ? stored : 'system';
  applyTheme(current);
  var btn = document.getElementById('theme-toggle');
  btn.addEventListener('click', function () {
    current = order[(order.indexOf(current) + 1) % order.length];
    applyTheme(current);
  });
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var handler = function () { if (current === 'system') { readPalette(); drawCharts(); } };
    if (mq.addEventListener) mq.addEventListener('change', handler);
    else if (mq.addListener) mq.addListener(handler);
  }
}

/* ============================================================ entity picker */

function fillPicker() {
  var picker = document.getElementById('entity-picker');
  clear(picker);
  picker.appendChild(el('option', { value: '', text: 'Jump to a team or player…' }));
  var gt = el('optgroup', { label: 'Teams' });
  IDX.ladder.forEach(function (t) {
    gt.appendChild(el('option', { value: 'team:' + t.slug, text: t.name }));
  });
  picker.appendChild(gt);
  var gp = el('optgroup', { label: 'Players' });
  (S.players || []).slice().sort(function (a, b) {
    return String(a.name).localeCompare(String(b.name));
  }).forEach(function (p) {
    gp.appendChild(el('option', { value: 'player:' + p.slug,
      text: p.name + ' — ' + (teamOf(p.team_code) ? teamShort(p.team_code) : '') }));
  });
  picker.appendChild(gp);
  picker.addEventListener('change', function () {
    var v = picker.value;
    if (!v) return;
    var bits = v.split(':');
    location.hash = '#/' + bits[0] + '/' + bits[1];
  });
}

/* ================================================================== boot === */

function fetchJson(url) {
  if (typeof fetch !== 'function') return Promise.reject(new Error('no fetch'));
  return fetch(url, { cache: 'no-store' }).then(function (r) {
    if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
    return r.json();
  });
}

/* Priority: the real file over http, then a season-data.js carrier (the file://
 * escape hatch, since browsers block fetch of a sibling file), then a clear
 * message.
 *
 * There is deliberately no sample/fixture fallback. Both sources here are written
 * by the same ingest run, so they cannot disagree; a third checked-in copy would
 * go stale the moment a round landed and then render plausible-but-wrong numbers
 * on the very failure it was meant to soften. Showing nothing, with instructions,
 * is the safer failure — a wrong ladder looks exactly like a right one. */
function loadSeason() {
  return fetchJson('season.json')
    .then(function (data) { return { data: data, note: 'source: season.json' }; })
    .catch(function (err) {
      if (window.SEASON) {
        return { data: window.SEASON, note: 'source: season-data.js' };
      }
      throw err;
    });
}

function showLoadFailure(err) {
  var main = document.getElementById('view');
  clear(main);
  main.appendChild(el('div', { class: 'view-head' }, [
    el('h1', { text: 'No season data found' }),
    el('p', { text: 'The dashboard needs season.json (or a season-data.js that assigns ' +
      'window.SEASON) beside this page.' })
  ]));
  var card = el('div', { class: 'card' });
  card.appendChild(el('p', { text: 'Browsers block reading a sibling file over file://, so ' +
    'one of these will fix it:' }));
  var list = el('ol');
  [
    'Run the ingest, which writes both carriers: python3 tools/ingest.py',
    'Or serve the folder: python3 -m http.server 8000 from the dashboard directory, then open http://localhost:8000/',
    'Or open the page over http from wherever season.json is published.'
  ].forEach(function (s) { list.appendChild(el('li', { text: s })); });
  card.appendChild(list);
  card.appendChild(el('p', { class: 'foot muted', style: { 'font-size': '12px' },
    text: 'Loader said: ' + (err && err.message ? err.message : String(err)) }));
  main.appendChild(card);
  var host = document.getElementById('health');
  clear(host);
  host.appendChild(el('div', { class: 'health-row' }, [
    el('span', { class: 'pill critical' }, [
      el('span', { class: 'dot', 'aria-hidden': 'true' }),
      el('span', { text: '✕ No data loaded' })
    ])
  ]));
}

function boot() {
  readPalette();
  loadSeason().then(function (res) {
    S = res.data;
    SOURCE_NOTE = res.note;
    IDX = indexSeason(S);
    var meta = S.meta || {};
    var brand = document.getElementById('brand-sub');
    brand.textContent = 'Division ' + (meta.division || '?') + ' · ' + (meta.season || '') +
      ' · generated ' + (meta.generated || 'unknown').replace('T', ' ');
    fillPicker();
    renderHealth();
    if (IDX.overflowTeams.length) {
      // Never generate a 7th hue: say so instead of inventing one.
      var host = document.getElementById('health');
      host.appendChild(note('warning', 'Colour slots',
        IDX.overflowTeams.length + ' team(s) beyond the ' + MAX_SERIES +
        ' categorical slots are drawn in the neutral context grey.'));
    }
    initTheme();
    render();
    window.addEventListener('hashchange', render);
    window.addEventListener('resize', onResize);
    var footer = document.getElementById('foot-note');
    footer.textContent = 'Generated ' + (meta.generated || '—') + ' from ' +
      (meta.source_dir || 'the scorecard folder') + ' · ' + SOURCE_NOTE +
      ' · points, ladder and averages computed by tennis/stats.py.';
  }).catch(function (err) {
    initTheme();
    showLoadFailure(err);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
