// ---- Configuration -------------------------------------------------------
// Swap SHEET_ID to the real production spreadsheet when it's ready; the tab
// names/gids should stay the same if the real sheet was cloned from this one.
const CONFIG = {
  SHEET_ID: '1m2hLDmQizZcvnPovnHoEJGhWvf76DZiiMO2gAaBuWVU', // "COBA DASHBOARD" (test copy)
  DASHBOARD_GID: '0', // computed "Dashboard" tab: Nama, Kabupaten, Segmen Peserta, Nilai Pre/Post Test, Status, Peningkatan
  RESPONSES_SHEET_NAME: 'SIMULASI PRETEST', // raw form-responses tab (used only for its Timestamp column)
  REFRESH_MS: 3 * 60 * 1000, // auto-refresh every 3 minutes
};

// Lampung's 15 kabupaten/kota with approximate centroid coordinates, used to
// place map markers without needing to source/host a boundary GeoJSON file.
const LAMPUNG_CENTROIDS = {
  'Bandar Lampung': [-5.3971, 105.2668],
  'Metro': [-5.1131, 105.3067],
  'Lampung Barat': [-5.1000, 104.2333],
  'Lampung Selatan': [-5.5167, 105.6167],
  'Lampung Tengah': [-4.9500, 105.2667],
  'Lampung Timur': [-5.1333, 105.6167],
  'Lampung Utara': [-4.8833, 104.9333],
  'Mesuji': [-3.9833, 105.4167],
  'Pesawaran': [-5.4667, 105.1333],
  'Pesisir Barat': [-5.2000, 103.9500],
  'Pringsewu': [-5.3585, 104.9744],
  'Tanggamus': [-5.4667, 104.6167],
  'Tulang Bawang': [-4.3833, 105.6667],
  'Tulang Bawang Barat': [-4.4333, 105.0500],
  'Way Kanan': [-4.5500, 104.5833],
};

// ---- Fetching the Google Sheet (JSONP, since the gviz endpoint sends no
// CORS headers and a plain fetch() would be blocked cross-origin) ---------
let jsonpCounter = 0;
function fetchGvizTable({ gid, sheetName }) {
  return new Promise((resolve, reject) => {
    const callbackName = `__gviz_cb_${Date.now()}_${jsonpCounter++}`;
    const params = new URLSearchParams();
    params.set('tqx', `out:json;responseHandler:${callbackName}`);
    if (gid !== undefined) params.set('gid', gid);
    if (sheetName) params.set('sheet', sheetName);
    const url = `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/gviz/tq?${params.toString()}`;

    const script = document.createElement('script');
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout saat memuat data dari Google Sheets.'));
    }, 15000);

    function cleanup() {
      clearTimeout(timeoutId);
      delete window[callbackName];
      script.remove();
    }

    window[callbackName] = (json) => {
      cleanup();
      if (json.status === 'error') {
        const msg = (json.errors && json.errors[0] && json.errors[0].detailed_message) || 'Gagal memuat data.';
        reject(new Error(msg));
        return;
      }
      resolve(json.table);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error('Gagal memuat skrip dari Google Sheets. Periksa apakah sheet dibagikan publik.'));
    };
    script.src = url;
    document.head.appendChild(script);
  });
}

function tableToObjects(table) {
  const labels = table.cols.map((c, i) => c.label || `col_${i}`);
  return table.rows.map((row) => {
    const obj = {};
    labels.forEach((label, i) => {
      const cell = row.c && row.c[i];
      obj[label] = cell ? cell.v : null;
    });
    return obj;
  });
}

// gviz encodes datetimes as the pseudo-string "Date(y,m,d,h,mi,s)" (month is
// already 0-indexed, matching the JS Date constructor).
function parseGvizDate(value) {
  if (typeof value !== 'string' || !value.startsWith('Date(')) return null;
  const parts = value.slice(5, -1).split(',').map(Number);
  const [y, mo, d, h = 0, mi = 0, s = 0] = parts;
  return new Date(y, mo, d, h, mi, s);
}

const INDO_MONTHS = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

// e.g. "24 Februari 2026"
function formatIndoDate(date) {
  return `${date.getDate()} ${INDO_MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function dateKeyToDate(key) {
  const [y, mo, d] = key.split('-').map(Number);
  return new Date(y, mo - 1, d);
}

// ---- Aggregation helpers ---------------------------------------------------
function normalizeKey(value) {
  const key = (value ?? '').toString().trim();
  return key || 'Tidak diketahui';
}

function countBy(rows, field) {
  const counts = new Map();
  for (const r of rows) {
    const key = normalizeKey(r[field]);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function avgByGroup(rows, groupField, valueField) {
  const sums = new Map();
  const counts = new Map();
  for (const r of rows) {
    const key = normalizeKey(r[groupField]);
    const val = Number(r[valueField]) || 0;
    sums.set(key, (sums.get(key) || 0) + val);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const result = new Map();
  for (const [k, sum] of sums) result.set(k, sum / counts.get(k));
  return result;
}

function countByDate(rawRows, timestampField) {
  const counts = new Map();
  for (const r of rawRows) {
    const date = parseGvizDate(r[timestampField]);
    if (!date) continue;
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return new Map([...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

function computeKPIs(dashboardRows) {
  const total = dashboardRows.length;
  const sum = (field) => dashboardRows.reduce((s, r) => s + (Number(r[field]) || 0), 0);
  const completed = dashboardRows.filter((r) => r['Status Post Test'] === 'Sudah').length;
  return {
    total,
    avgPre: total ? sum('Nilai Pre Test') / total : 0,
    avgPost: total ? sum('Nilai Post Test') / total : 0,
    avgImprove: total ? sum('Peningkatan') / total : 0,
    completionRate: total ? (completed / total) * 100 : 0,
  };
}

// ---- Chart.js theme helpers -------------------------------------------------
function cssVar(name) {
  return getComputedStyle(document.querySelector('.viz-root')).getPropertyValue(name).trim();
}

function baseChartOptions(overrides = {}) {
  return Object.assign(
    {
      responsive: true,
      maintainAspectRatio: false,
      color: cssVar('--text-secondary'),
      plugins: {
        legend: { labels: { color: cssVar('--text-secondary') } },
      },
      scales: {
        x: { grid: { color: cssVar('--gridline') }, ticks: { color: cssVar('--text-secondary') } },
        y: { grid: { color: cssVar('--gridline') }, ticks: { color: cssVar('--text-secondary') }, beginAtZero: true },
      },
    },
    overrides
  );
}

const chartInstances = {};
function upsertChart(id, config) {
  if (chartInstances[id]) {
    chartInstances[id].destroy();
  }
  const ctx = document.getElementById(id).getContext('2d');
  chartInstances[id] = new Chart(ctx, config);
}

function renderDirectLegend(listId, entries, colors) {
  const el = document.getElementById(listId);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  el.innerHTML = entries
    .map(([label, value], i) => {
      const pct = total ? Math.round((value / total) * 100) : 0;
      return `<li><span class="swatch" style="background:${colors[i]}"></span><span class="legend-label">${label}</span><span class="legend-value">${value} (${pct}%)</span></li>`;
    })
    .join('');
}

// ---- Map --------------------------------------------------------------------
let mapInstance = null;
let markerLayer = null;

function renderMap(kabupatenCounts, kabupatenAvgImprove) {
  if (!mapInstance) {
    // Locked to Lampung: viewers can click markers for details, but can't
    // pan/zoom the map away from this view (accidental or otherwise).
    mapInstance = L.map('map', {
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      touchZoom: false,
      keyboard: false,
      zoomControl: false,
    }).setView([-4.95, 105.0], 8);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 12,
    }).addTo(mapInstance);
    markerLayer = L.layerGroup().addTo(mapInstance);
  }
  markerLayer.clearLayers();

  const maxCount = Math.max(1, ...kabupatenCounts.values());
  for (const [name, coords] of Object.entries(LAMPUNG_CENTROIDS)) {
    const count = kabupatenCounts.get(name) || 0;
    if (count === 0) continue;
    const radius = 8 + Math.sqrt(count / maxCount) * 24;
    const avgImprove = kabupatenAvgImprove.get(name);
    const marker = L.circleMarker(coords, {
      radius,
      color: cssVar('--seq-650') || '#104281',
      weight: 1,
      fillColor: cssVar('--seq-450') || '#2a78d6',
      fillOpacity: 0.55,
    });
    marker.bindPopup(
      `<strong>${name}</strong><br/>Peserta: ${count}` +
        (avgImprove !== undefined ? `<br/>Rata-rata peningkatan: ${avgImprove.toFixed(1)} poin` : '')
    );
    marker.addTo(markerLayer);
  }
}

// ---- Rendering ---------------------------------------------------------------
function renderTable(rows) {
  const body = document.getElementById('table-body');
  body.innerHTML = rows
    .map(
      (r) => `<tr>
        <td>${r['Nama'] ?? ''}</td>
        <td>${r['Kabupaten'] ?? ''}</td>
        <td>${r['Tempat Kegiatan (Tempat Acara)'] ?? ''}</td>
        <td>${r['Segmen Peserta'] ?? ''}</td>
        <td>${r['Nilai Pre Test'] ?? ''}</td>
        <td>${r['Nilai Post Test'] ?? ''}</td>
        <td>${r['Peningkatan'] ?? ''}</td>
        <td>${r['Status Post Test'] ?? ''}</td>
      </tr>`
    )
    .join('');
}

function renderDashboard(dashboardRows, responseRows) {
  const kpis = computeKPIs(dashboardRows);
  document.getElementById('kpi-total').textContent = kpis.total;
  document.getElementById('kpi-pre').textContent = kpis.avgPre.toFixed(1);
  document.getElementById('kpi-post').textContent = kpis.avgPost.toFixed(1);
  document.getElementById('kpi-improve').textContent = `+${kpis.avgImprove.toFixed(1)}`;
  document.getElementById('kpi-completion').textContent = `${kpis.completionRate.toFixed(0)}%`;

  // Bar: participants per Kabupaten
  const kabupatenCounts = countBy(dashboardRows, 'Kabupaten');
  const kabupatenEntries = [...kabupatenCounts.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  upsertChart('chart-kabupaten', {
    type: 'bar',
    data: {
      labels: kabupatenEntries.map(([k]) => k),
      datasets: [{ label: 'Jumlah Peserta', data: kabupatenEntries.map(([, v]) => v), backgroundColor: cssVar('--series-1') }],
    },
    options: baseChartOptions({ plugins: { legend: { display: false } } }),
  });

  // Donut: Segmen Peserta
  const segmenCounts = countBy(dashboardRows, 'Segmen Peserta');
  const segmenEntries = [...segmenCounts.entries()];
  const segmenColors = [cssVar('--series-1'), cssVar('--series-2'), cssVar('--series-3'), cssVar('--series-4')];
  upsertChart('chart-segmen', {
    type: 'doughnut',
    data: {
      labels: segmenEntries.map(([k]) => k),
      datasets: [{ data: segmenEntries.map(([, v]) => v), backgroundColor: segmenColors }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
  });
  renderDirectLegend('legend-segmen', segmenEntries, segmenColors);

  // Donut: Status Post Test (true state -> status colors)
  const statusCounts = countBy(dashboardRows, 'Status Post Test');
  const statusOrder = ['Sudah', 'Belum'];
  const statusEntries = statusOrder.filter((s) => statusCounts.has(s)).map((s) => [s, statusCounts.get(s)]);
  for (const [k, v] of statusCounts) if (!statusOrder.includes(k)) statusEntries.push([k, v]);
  const statusColors = statusEntries.map(([k]) => (k === 'Sudah' ? cssVar('--status-good') : cssVar('--status-warning')));
  upsertChart('chart-status', {
    type: 'doughnut',
    data: {
      labels: statusEntries.map(([k]) => k),
      datasets: [{ data: statusEntries.map(([, v]) => v), backgroundColor: statusColors }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
  });
  renderDirectLegend('legend-status', statusEntries, statusColors);

  // Grouped bar: avg Pre vs Post per Kabupaten
  const avgPre = avgByGroup(dashboardRows, 'Kabupaten', 'Nilai Pre Test');
  const avgPost = avgByGroup(dashboardRows, 'Kabupaten', 'Nilai Post Test');
  const kabupatenNames = [...new Set([...avgPre.keys(), ...avgPost.keys()])].sort();
  upsertChart('chart-prepost', {
    type: 'bar',
    data: {
      labels: kabupatenNames,
      datasets: [
        { label: 'Pre-Test', data: kabupatenNames.map((k) => avgPre.get(k) || 0), backgroundColor: cssVar('--series-1') },
        { label: 'Post-Test', data: kabupatenNames.map((k) => avgPost.get(k) || 0), backgroundColor: cssVar('--series-4') },
      ],
    },
    options: baseChartOptions(),
  });

  // Line: submissions per date (from the raw form-responses tab, which has Timestamp)
  const dateCounts = countByDate(responseRows, 'Timestamp');
  upsertChart('chart-submissions', {
    type: 'line',
    data: {
      labels: [...dateCounts.keys()].map((k) => formatIndoDate(dateKeyToDate(k))),
      datasets: [
        {
          label: 'Jumlah Submission',
          data: [...dateCounts.values()],
          borderColor: cssVar('--series-1'),
          backgroundColor: cssVar('--series-1'),
          tension: 0.25,
          pointRadius: 4,
        },
      ],
    },
    options: baseChartOptions({ plugins: { legend: { display: false } } }),
  });

  // Map
  const avgImproveByKabupaten = avgByGroup(dashboardRows, 'Kabupaten', 'Peningkatan');
  renderMap(kabupatenCounts, avgImproveByKabupaten);

  renderTable(dashboardRows);
}

// ---- Load cycle ---------------------------------------------------------------
async function loadAndRender() {
  const errorBanner = document.getElementById('error-banner');
  try {
    const [dashboardTable, responsesTable] = await Promise.all([
      fetchGvizTable({ gid: CONFIG.DASHBOARD_GID }),
      fetchGvizTable({ sheetName: CONFIG.RESPONSES_SHEET_NAME }),
    ]);
    const dashboardRows = tableToObjects(dashboardTable);
    const responseRows = tableToObjects(responsesTable);
    renderDashboard(dashboardRows, responseRows);

    errorBanner.hidden = true;
    const now = new Date();
    document.getElementById('last-updated').textContent =
      `Terakhir diperbarui: ${formatIndoDate(now)}, ${now.toLocaleTimeString('id-ID')}`;
  } catch (err) {
    console.error(err);
    errorBanner.hidden = false;
    errorBanner.textContent = `Gagal memuat data: ${err.message}`;
  }
}

document.getElementById('refresh-btn').addEventListener('click', loadAndRender);
loadAndRender();
setInterval(loadAndRender, CONFIG.REFRESH_MS);
