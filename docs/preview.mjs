// Regenerates docs/preview.svg from the real render() output, so the picture in the README
// can never drift from what the status line actually prints. Run: npm run preview
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { render, visibleWidth } from '../statusline.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(fs.readFileSync(path.join(here, '..', 'tests', 'fixtures', 'input.json'), 'utf8'));

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const NOW = 1790000000 * 1000 - 2.5 * HOUR;
const clean = { branch: 'main', ahead: 0, behind: 0, gone: false, changes: 3, conflicts: 0, op: '' };
const env = extra => ({ now: NOW, columns: 0, git: () => clean, account: () => 'dev@example.com', ...extra });

const attention = structuredClone(base);
attention.context_window.used_percentage = 31;
attention.context_window.current_usage.cache_read_input_tokens = 305563;
attention.prompt_cache.warm = false;
attention.prompt_cache.recache_tokens_if_cold = 310000;
attention.fast_mode = true;
attention.rate_limits.five_hour = { used_percentage: 30, resets_at: (NOW + 3 * HOUR) / 1000 };
attention.rate_limits.seven_day = { used_percentage: 50, resets_at: (NOW + 5 * DAY) / 1000 };

const scenarios = [
  ['All is well: grey everywhere, the budget light is green', render(base, env())],
  [
    'Something needs attention: a rebase left half-way, a heavy context with a cold cache, a week burning too fast',
    render(attention, env({ git: () => ({ ...clean, changes: 9, op: 'REBASE' }) })),
  ],
  ['A narrow terminal: segments shorten first, the budget stays', render(base, env({ columns: 72 }))],
];

// GitHub dark palette
const COLOR = { fg: '#e6edf3', dim: '#7d8590', 31: '#ff7b72', 33: '#e3b341', bg: '#0d1117', border: '#30363d' };
const FONT = 14;
const CHAR = 8.45; // advance width of the monospace font at 14px
const PAD = 24;

const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function toTspans(line) {
  const out = [];
  let dim = false;
  let color = null;
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    const m = part.match(/^\x1b\[([0-9;]*)m$/);
    if (m) {
      if (m[1] === '0') [dim, color] = [false, null];
      else if (m[1] === '2') dim = true;
      else color = m[1];
      continue;
    }
    if (!part) continue;
    const fill = color ? COLOR[color] : dim ? COLOR.dim : COLOR.fg;
    out.push(`<tspan fill="${fill}">${escape(part)}</tspan>`);
  }
  return out.join('');
}

const widest = Math.max(...scenarios.map(([, line]) => visibleWidth(line)));
const width = Math.ceil(PAD * 2 + widest * CHAR);
const rowHeight = 64;
const height = 44 + scenarios.length * rowHeight + 8;

const rows = scenarios
  .map(([caption, line], i) => {
    const y = 44 + i * rowHeight;
    return [
      `  <text x="${PAD}" y="${y + 14}" class="caption">${escape(caption)}</text>`,
      `  <text x="${PAD}" y="${y + 42}" class="line" xml:space="preserve">${toTspans(line)}</text>`,
    ].join('\n');
  })
  .join('\n');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Three examples of the status line: all is well, something needs attention, and a narrow terminal">
  <style>
    .caption { font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; fill: ${COLOR.dim}; }
    .line { font: ${FONT}px ui-monospace, SFMono-Regular, "Cascadia Mono", Menlo, Consolas, monospace; }
  </style>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="${COLOR.bg}" stroke="${COLOR.border}"/>
  <circle cx="${PAD}" cy="20" r="5" fill="#ff5f57"/>
  <circle cx="${PAD + 16}" cy="20" r="5" fill="#febc2e"/>
  <circle cx="${PAD + 32}" cy="20" r="5" fill="#28c840"/>
${rows}
</svg>
`;

fs.writeFileSync(path.join(here, 'preview.svg'), svg);
console.log(`docs/preview.svg written (${width}x${height})`);
