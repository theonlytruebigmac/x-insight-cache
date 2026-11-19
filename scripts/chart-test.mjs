import assert from 'node:assert/strict';
import { renderChart } from '../src/public/chart.js';

class Element {
  constructor(name) {
    this.name = name;
    this.attributes = {};
    this.children = [];
    this.textContent = '';
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  get id() { return this.attributes.id; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
}

globalThis.document = { createElementNS: (_namespace, name) => new Element(name) };
const series = [
  { field: 'requests', name: 'requests', label: 'Requests' },
  { field: 'misses', name: 'misses', label: 'Misses' }
];
const now = Date.UTC(2026, 10, 19, 0, 30) / 1000;
Date.now = () => now * 1000;

function chart() {
  const svg = new Element('svg');
  svg.setAttribute('id', 'test-chart');
  return svg;
}

{
  const svg = chart();
  renderChart(svg, {
    period: '24h', bucketSeconds: 3600,
    buckets: [{ bucket: now - 1800 - 3600, requests: 1, misses: 0 }]
  }, series);
  const lines = svg.children.filter((node) => node.name === 'polyline');
  const points = svg.children.filter((node) => node.name === 'circle');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].attributes.points.split(' ').length, 24);
  assert.equal(points.length, 1);
  assert.match(points[0].children[0].textContent, /Requests: 1/);
  assert.deepEqual(svg.children.filter((node) => node.attributes.class === 'chart-axis').slice(0, 2).map((node) => node.textContent), ['0', '1']);
  assert.equal(svg.attributes['aria-describedby'], 'test-chart-description');
  assert.equal(svg.children[0].textContent, 'Requests: 1. Misses: 0.');
  console.log('  ok   sparse hourly counts render as labeled points');
}

{
  const svg = chart();
  renderChart(svg, { period: '24h', bucketSeconds: 3600, buckets: [] }, series);
  assert.equal(svg.children.filter((node) => node.name === 'polyline').length, 0);
  assert.ok(svg.children.some((node) => node.attributes.class === 'chart-empty'));
  assert.deepEqual(svg.children.filter((node) => node.attributes.class === 'chart-axis').slice(0, 2).map((node) => node.textContent), ['0', '1']);
  console.log('  ok   empty history has no lines or repeated axis ticks');
}

{
  const svg = chart();
  const bucket = Math.floor(now / 86400) * 86400;
  renderChart(svg, {
    period: '7d', bucketSeconds: 86400,
    buckets: [{ bucket, requests: 58, misses: 29 }]
  }, series);
  const axisLabels = svg.children.filter((node) => node.attributes.class === 'chart-axis').map((node) => node.textContent);
  assert.deepEqual(axisLabels.slice(0, 4), ['0', '20', '40', '60']);
  assert.equal(axisLabels.at(-1), new Date(bucket * 1000).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' }));
  const titles = svg.children.filter((node) => node.name === 'circle').map((node) => node.children[0].textContent);
  assert.ok(titles.every((title) => title.includes('(UTC day)')));
  console.log('  ok   daily buckets use UTC dates and scaled axes');
}
