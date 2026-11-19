const $ = (id) => document.getElementById(id);
let page = 1;
let search = '';
let loadVersion = 0;
let refreshTimer;
const number = new Intl.NumberFormat();
const entryColumns = [
  ['username', 'Handle'],
  ['location', 'Location'],
  ['device', 'Device'],
  ['location_accurate', 'Accurate location'],
  ['affiliation', 'Affiliation'],
  ['account_id', 'Account ID'],
  ['created_at', 'Account created'],
  ['username_changes', 'Handle changes'],
  ['updated_at', 'Last cached']
];

function notice(message = '') {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

function showLogin() {
  loadVersion++;
  clearInterval(refreshTimer);
  $('dashboard-view').hidden = true;
  $('login-view').hidden = false;
  $('entries').replaceChildren();
  $('new-key').hidden = true;
  $('new-key-value').textContent = '';
  $('api-keys').replaceChildren();
  for (const id of ['total-entries', 'total-contributions', 'retention', 'last-updated', 'uptime', 'refreshed', 'results-label', 'page-label']) {
    $(id).textContent = '';
  }
}

async function api(path, options = {}) {
  const res = await fetch(`/admin/api/${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    credentials: 'same-origin'
  });
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 401) showLogin();
    throw new Error(data.error || `Request failed (${res.status}).`);
  }
  return data;
}

function date(value) {
  return value == null ? '-' : new Date(typeof value === 'number' ? value * 1000 : value).toLocaleString();
}

function currentFilters() {
  const [sort, direction] = $('sort-filter').value.split(':');
  return {
    search,
    page,
    pageSize: $('page-size').value,
    device: $('device-filter').value,
    accurate: $('accuracy-filter').value,
    freshness: $('freshness-filter').value,
    sort,
    direction
  };
}

function entryFreshness(entry, retentionDays) {
  const ageDays = (Date.now() / 1000 - entry.updated_at) / 86400;
  const warningDays = Math.min(7, Math.max(1, Math.ceil(retentionDays * 0.2)));
  if (ageDays >= retentionDays) return 'expired';
  return ageDays >= retentionDays - warningDays ? 'expiring' : 'fresh';
}

function renderBreakdown(id, items) {
  const list = $(id);
  if (!items.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No cached data yet';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...items.map((item) => {
    const li = document.createElement('li');
    const label = document.createElement('span');
    const count = document.createElement('span');
    label.textContent = item.name;
    count.textContent = number.format(item.count);
    count.className = 'breakdown-count';
    li.append(label, count);
    return li;
  }));
}

function renderChart(svg, history, series) {
  const ns = 'http://www.w3.org/2000/svg';
  const element = (name, attrs = {}) => {
    const node = document.createElementNS(ns, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  const width = 640, height = 220, left = 38, right = 12, top = 12, bottom = 30;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const count = history.period === '24h' ? 24 : history.period === '7d' ? 7 : 30;
  const start = Math.floor(Date.now() / (history.bucketSeconds * 1000)) * history.bucketSeconds -
    (count - 1) * history.bucketSeconds;
  const buckets = new Map(history.buckets.map((bucket) => [bucket.bucket, bucket]));
  const values = Array.from({ length: count }, (_, i) => buckets.get(start + i * history.bucketSeconds) || {});
  const maximum = Math.max(1, ...values.flatMap((v) => series.map((line) => Number(v[line.field]) || 0)));
  const hasData = values.some((v) => series.some((line) => Number(v[line.field]) > 0));
  svg.replaceChildren();
  for (let tick = 0; tick <= 4; tick++) {
    const y = top + plotHeight * tick / 4;
    const grid = element('line', { x1: left, y1: y, x2: width - right, y2: y, class: 'chart-gridline' });
    const label = element('text', { x: left - 7, y: y + 3, 'text-anchor': 'end', class: 'chart-axis' });
    label.textContent = number.format(Math.round(maximum * (4 - tick) / 4));
    svg.append(grid, label);
  }
  if (!hasData) {
    const empty = element('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'chart-empty' });
    empty.textContent = 'Activity will appear here as requests arrive';
    svg.append(empty);
  } else {
    for (const line of series) {
      const points = values.map((value, i) => {
        const x = left + plotWidth * i / (count - 1);
        const y = top + plotHeight * (1 - (Number(value[line.field]) || 0) / maximum);
        return `${x},${y}`;
      });
      svg.append(element('polyline', { points: points.join(' '), class: `chart-line series-${line.name}` }));
    }
  }
  for (const i of [0, Math.floor((count - 1) / 2), count - 1]) {
    const time = new Date((start + i * history.bucketSeconds) * 1000);
    const label = element('text', {
      x: left + plotWidth * i / (count - 1), y: height - 7,
      'text-anchor': i === 0 ? 'start' : i === count - 1 ? 'end' : 'middle',
      class: 'chart-axis'
    });
    label.textContent = history.period === '24h'
      ? time.toLocaleTimeString([], { hour: 'numeric' })
      : time.toLocaleDateString([], { month: 'short', day: 'numeric' });
    svg.append(label);
  }
}

function showEntryDetails(entry, retentionDays) {
  $('dialog-title').textContent = `@${entry.username}`;
  const state = entryFreshness(entry, retentionDays);
  const values = entryColumns.slice(1).map(([field, label]) => [
    label,
    field === 'location_accurate' ? (entry[field] ? 'Accurate' : 'Approximate')
      : field.endsWith('_at') ? date(entry[field]) : entry[field] == null ? '-' : String(entry[field])
  ]);
  values.push(['Freshness', state === 'fresh' ? 'Fresh' : state === 'expiring' ? 'Near expiry' : 'Past retention']);
  $('detail-list').replaceChildren(...values.flatMap(([label, value]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    return [dt, dd];
  }));
  $('entry-dialog').showModal();
}

function renderEntries(entries, retentionDays) {
  $('entries').replaceChildren(...entries.map((entry) => {
    const tr = document.createElement('tr');
    const values = [
      `@${entry.username}`, entry.location, entry.device,
      entry.location_accurate ? 'Yes' : 'No', entry.affiliation, entry.account_id,
      date(entry.created_at), entry.username_changes, date(entry.updated_at)
    ];
    for (let i = 0; i < entryColumns.length; i++) {
      const td = document.createElement('td');
      td.dataset.label = entryColumns[i][1];
      td.textContent = values[i] == null ? '-' : String(values[i]);
      td.title = td.textContent;
      const state = entryFreshness(entry, retentionDays);
      if (i === 0 && state !== 'fresh') {
        const badge = document.createElement('span');
        badge.className = `freshness-pill ${state}`;
        badge.textContent = state === 'expired' ? 'Past retention' : 'Near expiry';
        td.append(badge);
      }
      tr.append(td);
    }
    const detail = document.createElement('td');
    detail.dataset.label = 'Details';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'row-details';
    button.textContent = 'View details';
    button.addEventListener('click', () => showEntryDetails(entry, retentionDays));
    detail.append(button);
    tr.append(detail);
    return tr;
  }));
}

async function loadKeys() {
  try {
    const { keys } = await api('keys');
    $('active-key-count').textContent = `${number.format(keys.length)} MANAGED KEY${keys.length === 1 ? '' : 'S'}`;
    $('no-keys').hidden = keys.length > 0;
    $('api-keys').replaceChildren(...keys.map((key) => {
      const tr = document.createElement('tr');
      for (const [value, label] of [
        [key.name, 'Label'],
        [key.keyPrefix + '…', 'Key prefix'],
        [date(key.createdAt), 'Created'],
        [date(key.lastUsedAt), 'Last used']
      ]) {
        const td = document.createElement('td');
        td.dataset.label = label;
        td.textContent = value;
        if (label === 'Key prefix') td.className = 'key-prefix';
        tr.append(td);
      }
      const cell = document.createElement('td');
      cell.dataset.label = 'Action';
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'revoke-button';
      revoke.textContent = 'Revoke';
      revoke.addEventListener('click', async () => {
        if (!window.confirm(`Revoke "${key.name}"? This immediately stops that extension key from working.`)) return;
        try {
          await api(`keys/${encodeURIComponent(key.id)}`, { method: 'DELETE' });
          $('key-notice').textContent = `Revoked "${key.name}".`;
          $('key-notice').hidden = false;
          await loadKeys();
        } catch (error) {
          $('key-notice').textContent = error.message;
          $('key-notice').hidden = false;
        }
      });
      cell.append(revoke);
      tr.append(cell);
      return tr;
    }));
  } catch (error) {
    $('key-notice').textContent = error.message;
    $('key-notice').hidden = false;
  }
}

async function load() {
  const version = ++loadVersion;
  $('refresh').disabled = true;
  $('previous').disabled = true;
  $('next').disabled = true;
  $('entries').setAttribute('aria-busy', 'true');
  notice();
  try {
    const period = $('history-period').value;
    const [stats, data, breakdowns, history] = await Promise.all([
      api('stats'),
      api(`entries?${new URLSearchParams(currentFilters())}`),
      api('breakdowns'),
      api(`history?period=${encodeURIComponent(period)}`)
    ]);
    if (version !== loadVersion) return;
    const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
    if (page > pages) {
      page = pages;
      return await load();
    }
    $('total-entries').textContent = number.format(stats.totalEntries);
    $('total-contributions').textContent = number.format(stats.totalContributions);
    $('retention').textContent = `${number.format(stats.retentionDays)} days`;
    $('last-updated').textContent = stats.lastUpdated ? date(stats.lastUpdated) : 'No contributions yet';
    const minutes = Math.floor(stats.uptimeSeconds / 60);
    $('uptime').textContent = `${Math.floor(minutes / 1440)}d ${Math.floor(minutes / 60) % 24}h ${minutes % 60}m`;
    const hits = history.buckets.reduce((sum, bucket) => sum + bucket.hits, 0);
    const notFoundHits = history.buckets.reduce((sum, bucket) => sum + (bucket.notFoundHits || 0), 0);
    const misses = history.buckets.reduce((sum, bucket) => sum + bucket.misses, 0);
    $('hit-rate').textContent = hits + notFoundHits + misses
      ? `${Math.round((hits + notFoundHits) * 100 / (hits + notFoundHits + misses))}%` : '—';
    $('hit-rate-caption').textContent = hits + notFoundHits + misses
      ? `Across ${number.format(hits + notFoundHits + misses)} account lookups in this period`
      : 'No lookups in this period yet';
    $('expiring-count').textContent = number.format(breakdowns.expiringEntries);
    $('expired-count').textContent = number.format(breakdowns.expiredEntries);
    $('freshness-caption').textContent = `Entries expire after ${stats.retentionDays} days; warning starts ${breakdowns.warningDays} days before.`;
    $('expiring-link').classList.toggle('expired', breakdowns.expiringEntries > 0);
    $('expired-link').classList.toggle('expired', breakdowns.expiredEntries > 0);
    $('expiring-link').disabled = false;
    $('expired-link').disabled = false;
    renderBreakdown('device-breakdown', breakdowns.devices);
    renderBreakdown('location-breakdown', breakdowns.locations);
    const selectedDevice = $('device-filter').value;
    $('device-filter').replaceChildren(new Option('All devices', ''));
    for (const item of breakdowns.devices) {
      if (item.name !== 'Unknown') $('device-filter').add(new Option(`${item.name} (${number.format(item.count)})`, item.name));
    }
    if ([...$('device-filter').options].some((option) => option.value === selectedDevice)) {
      $('device-filter').value = selectedDevice;
    }
    renderChart($('lookup-chart'), history, [
      { field: 'requests', name: 'requests' },
      { field: 'hits', name: 'hits' },
      { field: 'notFoundHits', name: 'not-found' },
      { field: 'misses', name: 'misses' },
      { field: 'lookupRateLimited', name: 'rate-limited' }
    ]);
    renderChart($('contribution-chart'), history, [
      { field: 'contributions', name: 'contributions' },
      { field: 'contributeRateLimited', name: 'rate-limited' }
    ]);
    renderEntries(data.entries, stats.retentionDays);
    $('empty').hidden = data.entries.length > 0;
    $('empty').textContent = search
      ? 'No accounts match your current search and filters.'
      : 'No cached accounts match these filters.';
    const start = data.total ? (page - 1) * data.pageSize + 1 : 0;
    const end = Math.min(page * data.pageSize, data.total);
    $('results-label').textContent = `${number.format(start)}-${number.format(end)} of ${number.format(data.total)} accounts`;
    $('page-label').textContent = `${page} / ${pages}`;
    $('previous').disabled = page <= 1;
    $('next').disabled = page >= pages;
    $('refreshed').textContent = `Refreshed ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    notice(error.message);
  } finally {
    if (version === loadVersion) {
      $('refresh').disabled = false;
      $('entries').removeAttribute('aria-busy');
    }
  }
}

async function showDashboard() {
  $('login-view').hidden = true;
  $('dashboard-view').hidden = false;
  page = 1;
  search = '';
  $('search').value = '';
  try { $('auto-refresh').value = localStorage.getItem('xic-auto-refresh') || '0'; } catch { $('auto-refresh').value = '0'; }
  setAutoRefresh();
  await Promise.all([load(), loadKeys()]);
}

function setAutoRefresh() {
  clearInterval(refreshTimer);
  const seconds = Number($('auto-refresh').value);
  if (seconds > 0) refreshTimer = setInterval(load, seconds * 1000);
}

async function exportEntries(format) {
  const filters = currentFilters();
  delete filters.page;
  delete filters.pageSize;
  filters.format = format;
  try {
    const res = await fetch(`/admin/api/export?${new URLSearchParams(filters)}`, {
      credentials: 'same-origin'
    });
    if (res.status === 401) {
      showLogin();
      throw new Error('Please log in to the dashboard.');
    }
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || `Export failed (${res.status}).`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `x-insight-cache.${format}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice();
  } catch (error) {
    notice(error.message);
  }
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('login-button').disabled = true;
  notice();
  try {
    await api('session', {
      method: 'POST',
      body: JSON.stringify({ username: $('username').value, password: $('password').value })
    });
    $('password').value = '';
    // Verify that the browser accepted the session cookie before showing data.
    await api('session');
    await showDashboard();
  } catch (error) {
    notice(error.message);
  } finally {
    $('login-button').disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  try {
    await api('session', { method: 'DELETE' });
    showLogin();
    notice();
  } catch (error) {
    notice(error.message);
  }
});

$('search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  search = $('search').value.trim();
  page = 1;
  load();
});
$('page-size').addEventListener('change', () => { page = 1; load(); });
for (const id of ['device-filter', 'accuracy-filter', 'freshness-filter', 'sort-filter']) {
  $(id).addEventListener('change', () => { page = 1; load(); });
}
$('history-period').addEventListener('change', load);
$('previous').addEventListener('click', () => { page--; load(); });
$('next').addEventListener('click', () => { page++; load(); });
$('refresh').addEventListener('click', load);
$('expiring-link').addEventListener('click', () => {
  $('freshness-filter').value = 'expiring';
  page = 1;
  load();
});
$('expired-link').addEventListener('click', () => {
  $('freshness-filter').value = 'expired';
  page = 1;
  load();
});
$('export-csv').addEventListener('click', () => exportEntries('csv'));
$('export-json').addEventListener('click', () => exportEntries('json'));
$('auto-refresh').addEventListener('change', () => {
  try { localStorage.setItem('xic-auto-refresh', $('auto-refresh').value); } catch { /* Optional preference. */ }
  setAutoRefresh();
});
$('key-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('key-form button');
  button.disabled = true;
  $('key-notice').hidden = true;
  $('new-key').hidden = true;
  try {
    const result = await api('keys', {
      method: 'POST',
      body: JSON.stringify({ name: $('key-name').value })
    });
    $('key-name').value = '';
    $('new-key-value').textContent = result.token;
    $('new-key').hidden = false;
    $('key-notice').textContent = 'Key created. Save it now; the full key cannot be viewed again.';
    $('key-notice').hidden = false;
    await loadKeys();
  } catch (error) {
    $('key-notice').textContent = error.message;
    $('key-notice').hidden = false;
  } finally {
    button.disabled = false;
  }
});
$('copy-key').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('new-key-value').textContent);
    $('key-notice').textContent = 'API key copied to clipboard.';
    $('key-notice').hidden = false;
  } catch {
    const selection = document.createRange();
    selection.selectNodeContents($('new-key-value'));
    const range = window.getSelection();
    range.removeAllRanges();
    range.addRange(selection);
    $('key-notice').textContent = 'Select and copy the highlighted key.';
    $('key-notice').hidden = false;
  }
});
$('close-dialog').addEventListener('click', () => $('entry-dialog').close());
$('entry-dialog').addEventListener('click', (event) => {
  if (event.target === $('entry-dialog')) $('entry-dialog').close();
});

try {
  await api('session');
  await showDashboard();
} catch (error) {
  showLogin();
  notice(error.message);
}
