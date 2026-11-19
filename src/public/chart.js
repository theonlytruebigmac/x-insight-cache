const number = new Intl.NumberFormat();
const axisNumber = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

export function renderChart(svg, history, series) {
  const ns = 'http://www.w3.org/2000/svg';
  const element = (name, attrs = {}) => {
    const node = document.createElementNS(ns, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  const width = 640, height = 220, left = 44, right = 12, top = 12, bottom = 30;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const count = history.period === '24h' ? 24 : history.period === '7d' ? 7 : 30;
  const start = Math.floor(Date.now() / (history.bucketSeconds * 1000)) * history.bucketSeconds -
    (count - 1) * history.bucketSeconds;
  const buckets = new Map(history.buckets.map((bucket) => [bucket.bucket, bucket]));
  const values = Array.from({ length: count }, (_, i) => buckets.get(start + i * history.bucketSeconds) || {});
  const maximum = Math.max(0, ...values.flatMap((value) => series.map((line) => Number(value[line.field]) || 0)));
  const roughStep = Math.max(1, maximum / 4);
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const step = [1, 2, 5, 10].find((factor) => factor * magnitude >= roughStep) * magnitude;
  const ticks = Math.max(1, Math.ceil(maximum / step));
  const scaleMax = ticks * step;
  const timeFor = (i) => new Date((start + i * history.bucketSeconds) * 1000);
  const daily = history.period !== '24h';
  const tooltipTime = (time) => daily
    ? `${time.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })} (UTC day)`
    : time.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

  svg.replaceChildren();
  const description = element('desc', { id: `${svg.id}-description` });
  description.textContent = series.map((line) => {
    const total = values.reduce((sum, value) => sum + (Number(value[line.field]) || 0), 0);
    return `${line.label}: ${number.format(total)}`;
  }).join('. ') + '.';
  svg.setAttribute('aria-describedby', description.id);
  svg.append(description);

  for (let tick = 0; tick <= ticks; tick++) {
    const y = top + plotHeight * (1 - tick / ticks);
    const grid = element('line', { x1: left, y1: y, x2: width - right, y2: y, class: 'chart-gridline' });
    const label = element('text', { x: left - 7, y: y + 3, 'text-anchor': 'end', class: 'chart-axis' });
    label.textContent = axisNumber.format(tick * step);
    svg.append(grid, label);
  }
  if (!maximum) {
    const empty = element('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'chart-empty' });
    empty.textContent = 'Activity will appear here as requests arrive';
    svg.append(empty);
  } else {
    for (const line of series) {
      if (!values.some((value) => Number(value[line.field]) > 0)) continue;
      const points = values.map((value, i) => {
        const x = left + plotWidth * i / (count - 1);
        const amount = Number(value[line.field]) || 0;
        const y = top + plotHeight * (1 - amount / scaleMax);
        return { x, y, amount, i };
      });
      svg.append(element('polyline', {
        points: points.map(({ x, y }) => `${x},${y}`).join(' '),
        class: `chart-line series-${line.name}`
      }));
      for (const point of points.filter(({ amount }) => amount > 0)) {
        const marker = element('circle', {
          cx: point.x, cy: point.y, r: 3, class: `chart-point series-${line.name}`
        });
        const title = element('title');
        title.textContent = `${tooltipTime(timeFor(point.i))}: ${line.label}: ${number.format(point.amount)}`;
        marker.append(title);
        svg.append(marker);
      }
    }
  }
  for (const i of [0, Math.floor((count - 1) / 2), count - 1]) {
    const label = element('text', {
      x: left + plotWidth * i / (count - 1), y: height - 7,
      'text-anchor': i === 0 ? 'start' : i === count - 1 ? 'end' : 'middle',
      class: 'chart-axis'
    });
    label.textContent = daily
      ? timeFor(i).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' })
      : timeFor(i).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    svg.append(label);
  }
}
