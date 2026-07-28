// backend/bench/render-cdf.mjs
// EXPERIMENTS.md E2 판정·보고 — "B TTFT 의 CDF, 3조건 겹쳐 그리기".
//
// e2-hol.jsonl → 순수 SVG. 외부 차트 라이브러리 없음(리포 의존성 0 추가, CSP 무관, diff 가능).
// 라이트/다크 양쪽에서 읽히도록 `prefers-color-scheme` 을 SVG 안에 인라인한다.
//
// 실행: node bench/render-cdf.mjs [--level 15000] [--out ../docs/assets/e2-hol-cdf.svg]

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const IN = arg('in', path.join(__dirname, 'out', 'e2-hol.jsonl'));
const OUT = arg('out', path.resolve(__dirname, '..', '..', 'docs', 'assets', 'e2-hol-cdf.svg'));
const LEVEL = Number(arg('level', '15000'));

/** CRT 그린 인광 팔레트 계열 — 조건별 색(부모 Aidit 디자인 시스템과 충돌 없는 3색). */
const COLORS = {
  'C-FIFO': '#ff6b6b',
  'C-REJECT': '#ffb454',
  'C-PAR': '#35e07f',
};

const W = 760;
const H = 420;
const M = { top: 44, right: 24, bottom: 56, left: 62 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function main() {
  const raw = await readFile(IN, 'utf8');
  const rows = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.ok && r.bTtftMs != null && r.L === LEVEL);

  if (!rows.length) throw new Error(`no rows for L=${LEVEL} in ${IN}`);

  const series = new Map();
  for (const r of rows) {
    if (!series.has(r.condition)) series.set(r.condition, []);
    series.get(r.condition).push(r.bTtftMs);
  }
  for (const arr of series.values()) arr.sort((a, b) => a - b);

  const allMax = Math.max(...rows.map((r) => r.bTtftMs));
  // x 축 상한: 데이터 최대의 5% 여유, 500ms 단위 올림.
  const xMax = Math.ceil((allMax * 1.05) / 500) * 500;

  const x = (v) => M.left + (v / xMax) * PW;
  const y = (p) => M.top + PH - p * PH;

  const parts = [];

  // ── 격자 + 축 ──
  const xTicks = 6;
  for (let i = 0; i <= xTicks; i++) {
    const v = (xMax / xTicks) * i;
    const px = x(v);
    parts.push(`<line class="grid" x1="${px.toFixed(1)}" y1="${M.top}" x2="${px.toFixed(1)}" y2="${M.top + PH}"/>`);
    parts.push(
      `<text class="tick" x="${px.toFixed(1)}" y="${M.top + PH + 18}" text-anchor="middle">${(v / 1000).toFixed(1)}s</text>`,
    );
  }
  for (let i = 0; i <= 4; i++) {
    const p = i / 4;
    const py = y(p);
    parts.push(`<line class="grid" x1="${M.left}" y1="${py.toFixed(1)}" x2="${M.left + PW}" y2="${py.toFixed(1)}"/>`);
    parts.push(`<text class="tick" x="${M.left - 10}" y="${(py + 4).toFixed(1)}" text-anchor="end">${(p * 100).toFixed(0)}%</text>`);
  }
  parts.push(`<line class="axis" x1="${M.left}" y1="${M.top + PH}" x2="${M.left + PW}" y2="${M.top + PH}"/>`);
  parts.push(`<line class="axis" x1="${M.left}" y1="${M.top}" x2="${M.left}" y2="${M.top + PH}"/>`);

  // ── 계단식 CDF ──
  const order = ['C-FIFO', 'C-REJECT', 'C-PAR'];
  let legendY = M.top + 12;
  const legend = [];
  for (const cond of order) {
    const arr = series.get(cond);
    if (!arr) continue;
    const n = arr.length;
    const pts = [`M ${M.left} ${y(0).toFixed(1)}`];
    arr.forEach((v, i) => {
      const px = x(v).toFixed(1);
      pts.push(`L ${px} ${y(i / n).toFixed(1)}`);
      pts.push(`L ${px} ${y((i + 1) / n).toFixed(1)}`);
    });
    pts.push(`L ${x(xMax).toFixed(1)} ${y(1).toFixed(1)}`);
    parts.push(`<path d="${pts.join(' ')}" fill="none" stroke="${COLORS[cond]}" stroke-width="2.4" stroke-linejoin="round"/>`);

    const p50 = arr[Math.floor((n - 1) * 0.5)];
    legend.push(
      `<g transform="translate(${M.left + PW - 210},${legendY})">` +
        `<rect width="14" height="3" y="5" fill="${COLORS[cond]}"/>` +
        `<text class="legend" x="22" y="9">${esc(cond)} — p50 ${(p50 / 1000).toFixed(2)}s (n=${n})</text>` +
        `</g>`,
    );
    legendY += 20;
  }
  parts.push(...legend);

  // ── 제목·축 라벨 ──
  parts.push(
    `<text class="title" x="${M.left}" y="24">B의 TTFT 누적분포 — 선행 작업 L=${(LEVEL / 1000).toFixed(0)}s</text>`,
  );
  parts.push(
    `<text class="axlabel" x="${M.left + PW / 2}" y="${H - 12}" text-anchor="middle">늦게 도착한 짧은 질문의 첫 토큰까지 시간 (초)</text>`,
  );
  parts.push(
    `<text class="axlabel" transform="translate(16,${M.top + PH / 2}) rotate(-90)" text-anchor="middle">누적 비율</text>`,
  );

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="B TTFT CDF by concurrency contract">
<style>
  .grid   { stroke: #d7dbe0; stroke-width: 1; }
  .axis   { stroke: #8b939c; stroke-width: 1.2; }
  .tick   { fill: #5b636b; font: 11px ui-monospace, monospace; }
  .legend { fill: #23282d; font: 12px ui-monospace, monospace; }
  .title  { fill: #14181c; font: 600 15px ui-sans-serif, system-ui, sans-serif; }
  .axlabel{ fill: #5b636b; font: 12px ui-sans-serif, system-ui, sans-serif; }
  @media (prefers-color-scheme: dark) {
    .grid   { stroke: #2b3238; }
    .axis   { stroke: #6f7880; }
    .tick   { fill: #9aa3ab; }
    .legend { fill: #dfe5ea; }
    .title  { fill: #f0f4f7; }
    .axlabel{ fill: #9aa3ab; }
  }
</style>
<rect width="${W}" height="${H}" fill="none"/>
${parts.join('\n')}
</svg>
`;

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, svg, 'utf8');
  console.log(`wrote ${OUT}  (L=${LEVEL}, ${rows.length} points, ${series.size} conditions)`);
}

await main();
