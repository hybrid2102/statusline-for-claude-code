#!/usr/bin/env node
// version: 1.1.0
//
// A status line for Claude Code that answers four questions at a glance:
//
//   where am I          📁 project   🌿 branch        -> am I working in the right place?
//   with what           🤖 model · effort             -> the levers that decide consumption
//   what does it cost   🧠 context   ❄ cold cache     -> how heavy is the next message?
//   what is left        🟢 5h · 7d   👤 account       -> can I push harder or should I slow down?
//
// Two rules shape everything below. Every segment must lead to a decision, or it is not
// shown. And colour means "look here": in normal conditions the line is almost entirely
// grey, so anything that lights up deserves attention.
//
// Claude Code pipes a JSON document on stdin and shows the first line printed on stdout.
// https://code.claude.com/docs/en/statusline

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const dim = s => `${DIM}${s}${RESET}`;
const paint = (color, s) => (color ? `${color}${s}${RESET}` : s);

// ---- formatting ---------------------------------------------------------------------------

export const formatTokens = n =>
  n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;

export const formatDuration = ms => {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m >= 1440) return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`;
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};

// resets_at has been seen as epoch seconds; ISO strings and milliseconds are accepted too,
// so a change of format degrades to a slightly wrong countdown rather than a crash
const toMs = v => {
  if (v == null) return NaN;
  return typeof v === 'number' ? (v > 1e12 ? v : v * 1000) : Date.parse(v);
};

// Visible width in terminal columns, needed to fit the line into COLUMNS: ANSI sequences
// take no space, emoji take two, and the emoji variation selector takes none but turns the
// character before it into a two-column emoji.
const VS16 = String.fromCodePoint(0xfe0f);
export const visibleWidth = s => {
  const cps = [...s.replace(/\x1b\[[0-9;]*m/g, '')];
  let w = 0;
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    if (c === VS16 || /\p{Mn}/u.test(c)) continue;
    w += /\p{Emoji_Presentation}/u.test(c) || cps[i + 1] === VS16 ? 2 : 1;
  }
  return w;
};

// ---- sources ------------------------------------------------------------------------------

// The active profile. transcript_path always lives in <profile>/projects/<slug>/<id>.jsonl,
// which makes it the most reliable clue: CLAUDE_CONFIG_DIR does not always reach the
// status line process.
export function profileDir(data) {
  const tp = data.transcript_path;
  if (tp) {
    const projects = path.dirname(path.dirname(tp));
    if (path.basename(projects) === 'projects') return path.dirname(projects);
  }
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// The account signed in to a profile. An alternative profile keeps .claude.json INSIDE its
// folder; the default one keeps it in the home directory, next to .claude/. The file is
// ~70 KB but parsing it takes under a millisecond, so it is read on every render: no cache
// to go stale, and a /login shows up immediately.
export function accountEmail(profile) {
  for (const p of [path.join(profile, '.claude.json'), `${profile}.json`, path.join(os.homedir(), '.claude.json')]) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8')).oauthAccount?.emailAddress || '';
    } catch {}
  }
  return '';
}

// An operation left half-way (rebase, merge, ...), read straight from the .git folder
// rather than through a second git process. In a worktree .git is a "gitdir: ..." file.
function gitOperation(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    const g = path.join(d, '.git');
    let gitDir = null;
    try {
      if (fs.statSync(g).isDirectory()) gitDir = g;
      else gitDir = path.resolve(d, fs.readFileSync(g, 'utf8').match(/gitdir:\s*(.+)/)[1].trim());
    } catch {}
    if (gitDir) {
      const has = f => fs.existsSync(path.join(gitDir, f));
      if (has('rebase-merge') || has('rebase-apply')) return 'REBASE';
      if (has('MERGE_HEAD')) return 'MERGE';
      if (has('CHERRY_PICK_HEAD')) return 'PICK';
      if (has('REVERT_HEAD')) return 'REVERT';
      if (has('BISECT_LOG')) return 'BISECT';
      return '';
    }
    if (path.dirname(d) === d) return '';
  }
}

// Parses `git status --porcelain --branch` (format v1).
export function parseGitStatus(out) {
  const [header = '', ...files] = out.split('\n').filter(Boolean);
  if (!header.startsWith('## ')) return null;
  const spec = header.slice(3).replace(/^No commits yet on /, '');
  const branch = spec.split(/\.\.\.| /)[0];
  return {
    branch: branch === 'HEAD' ? 'detached' : branch,
    ahead: Number(spec.match(/ahead (\d+)/)?.[1] || 0),
    behind: Number(spec.match(/behind (\d+)/)?.[1] || 0),
    gone: spec.includes('[gone]'),
    changes: files.length,
    conflicts: files.filter(l => /^(U.|.U|AA|DD)/.test(l)).length,
  };
}

// --no-optional-locks: without it git status takes index.lock, which can make a git
// command started at the same moment (by you or by Claude) fail.
export function gitInfo(dir) {
  let out;
  try {
    out = execFileSync('git', ['--no-optional-locks', 'status', '--porcelain', '--branch'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: dir,
      timeout: 1500,
      windowsHide: true,
    });
  } catch {
    return null;
  }
  const info = parseGitStatus(out);
  return info && { ...info, op: gitOperation(dir) };
}

// ---- segments -----------------------------------------------------------------------------
// Each returns { prio, text, short? } or nothing. See fit() for how prio and short are used.

function segProject(data) {
  const dir = data.workspace?.current_dir || data.cwd || '';
  const projectDir = data.workspace?.project_dir || dir;
  const base = data.workspace?.repo?.name || path.basename(projectDir) || projectDir || '?'; // a drive root has no basename
  const rel = path.relative(projectDir, dir);
  let where = base;
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    const parts = rel.split(/[\\/]/);
    where += '/' + (parts.length > 2 ? `${parts[0]}/…/${parts.at(-1)}` : parts.join('/'));
  } else if (rel) {
    where = path.basename(dir); // outside the project
  }
  const extra = data.workspace?.added_dirs?.length;
  return { prio: 100, text: `📁 ${where}${extra ? dim(` +${extra}`) : ''}`, short: `📁 ${base}` };
}

function segBranch(g, worktree) {
  if (!g) return;
  // in a worktree the same repository is open in several folders: the name says which
  const wt = worktree ? ` 🌳 ${worktree}` : '';
  // Pending changes and ahead/behind are the normal state of work, so they stay grey.
  // Red is kept for what blocks you: conflicts, an operation left half-way, a lost upstream.
  const alarm = [g.op, g.conflicts && `!${g.conflicts}`, g.gone && 'upstream gone'].filter(Boolean);
  const sync = `${g.ahead ? `↑${g.ahead}` : ''}${g.behind ? `↓${g.behind}` : ''}`;
  const state = [g.changes && `*${g.changes}`, sync].filter(Boolean).join(' ');
  const alarmText = alarm.length ? ' ' + paint(RED, alarm.join(' ')) : '';
  return {
    prio: 85,
    text: `🌿 ${g.branch}${wt}${state ? ' ' + dim(state) : ''}${alarmText}`,
    short: `🌿 ${g.branch}${wt}${alarm.length ? ' ' + paint(RED, alarm[0]) : ''}`,
  };
}

function segEngine(data) {
  const model = data.model?.display_name || data.model?.id || '?';
  const extras = [
    data.effort?.level,
    data.thinking?.enabled === false && 'no-think',
    data.output_style?.name && data.output_style.name !== 'default' && data.output_style.name,
  ].filter(Boolean);
  // fast mode costs more: the only engine setting that earns a colour
  const fast = data.fast_mode ? ' ' + paint(YELLOW, '⚡') : '';
  return {
    prio: 95,
    text: `🤖 ${model}${fast}${extras.length ? dim(' · ' + extras.join(' · ')) : ''}`,
    short: `🤖 ${model}${fast}`,
  };
}

function segContext(data) {
  const cw = data.context_window || {};
  const pct = cw.used_percentage;
  if (pct == null) return;
  const u = cw.current_usage;
  const tokens = u
    ? (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
    : null;
  // Past 200k tokens every message is heavy (and long-context pricing applies); past 70%
  // auto-compact is getting close. Those are the moments to consider /compact or /clear.
  // With a 1M window the percentage alone would stay green long after the first point.
  const color = pct >= 90 ? RED : pct >= 70 || tokens >= 200000 ? YELLOW : '';
  const pctText = `${Math.floor(pct)}%`;
  const size = tokens != null ? `${paint(color, formatTokens(tokens))} ${dim(pctText)}` : paint(color, pctText);

  // A cold cache means the next message resends the whole context at full price. Worth
  // knowing only when the context is big: that is when /clear beats carrying on.
  const pc = data.prompt_cache;
  const cold = pc?.caching_observed && pc.warm === false && pc.recache_tokens_if_cold >= 50000;
  return {
    prio: 90,
    text: `🧠 ${size}${cold ? ' ' + paint(YELLOW, `❄ ${formatTokens(pc.recache_tokens_if_cold)}`) : ''}`,
    short: `🧠 ${paint(color, pctText)}${cold ? ' ' + paint(YELLOW, '❄') : ''}`,
  };
}

const WINDOW_MS = { '5h': 5 * 3600e3, '7d': 7 * 24 * 3600e3 };

// On a subscription the real budget is the rate-limit windows. For each one, estimate where
// usage will be at reset if the current pace holds: the window started at resets_at minus
// its length, so projection = used / fraction elapsed.
//   risk < 70   green   you can push harder
//   risk < 100  yellow  keep going like this
//   risk >= 100 red     slow down: at this pace the budget runs out before the reset
export function assessWindows(rateLimits, now = Date.now()) {
  return [
    ['5h', rateLimits?.five_hour],
    ['7d', rateLimits?.seven_day],
  ]
    .filter(([, w]) => w?.used_percentage != null)
    .map(([label, w]) => {
      const end = toMs(w.resets_at);
      // an expired window is empty: the next message opens a new one
      const expired = Number.isFinite(end) && end <= now;
      const used = expired ? 0 : w.used_percentage;
      let projection = null;
      if (Number.isFinite(end) && !expired) {
        const elapsed = (now - (end - WINDOW_MS[label])) / WINDOW_MS[label];
        // in the first 10% of a window the projection swings too much to mean anything
        if (elapsed >= 0.1 && elapsed < 1) projection = used / elapsed;
      }
      // without a projection, judge on current usage with a more cautious threshold
      const risk = projection ?? used * 1.25;
      const light = risk >= 100 ? 'red' : risk >= 70 ? 'yellow' : 'green';
      return { label, used, projection, risk, light, resetsInMs: Number.isFinite(end) && !expired ? end - now : null };
    });
}

function segBudget(data, now) {
  const windows = assessWindows(data.rate_limits, now);
  if (!windows.length) {
    // pay-as-you-go accounts have no windows: the budget is dollars
    const cost = data.cost?.total_cost_usd;
    return cost != null ? { prio: 98, text: `💰 $${cost.toFixed(2)}` } : undefined;
  }
  const COLOR = { green: '', yellow: YELLOW, red: RED };
  const LIGHT = { green: '🟢', yellow: '🟡', red: '🔴' };
  const worst = windows.reduce((a, b) => (a.risk >= b.risk ? a : b));
  const show = w => {
    const c = COLOR[w.light];
    const proj = w.projection != null ? dim('→') + paint(c, `${Math.min(999, Math.round(w.projection))}%`) : '';
    const reset = w.resetsInMs != null ? dim(` ↺${formatDuration(w.resetsInMs)}`) : '';
    return `${dim(w.label)} ${paint(c, `${Math.round(w.used)}%`)}${proj}${reset}`;
  };
  return {
    prio: 98,
    text: `${LIGHT[worst.light]} ${windows.map(show).join(dim(' · '))}`,
    short: `${LIGHT[worst.light]} ${show(worst)}`,
  };
}

// Whose budget is being spent. With several profiles open in different windows this is
// the only way to tell them apart; the part before the @ is enough.
function segAccount(profile, email) {
  const name = path.basename(profile);
  const standard = name === '.claude';
  const id = [email.split('@')[0], standard ? '' : name].filter(Boolean).join(' · ');
  if (!id) return;
  return { prio: 40, text: `👤 ${dim(id)}`, short: standard ? undefined : `👤 ${dim(name)}` };
}

// ---- layout -------------------------------------------------------------------------------

// Every segment opens with its own emoji, which already marks where it starts: a plain gap
// is enough between segments and leaves " · " as the only mark, used inside a segment.
const GAP = '  ';

// When the line does not fit, give things up in order of importance. Shortening a segment
// costs less than dropping it, so its short form comes 30 points earlier: "Opus · high"
// becomes "Opus" before the branch disappears, and the budget is the last to go.
export function fit(segs, maxWidth) {
  const live = segs.map(s => ({ ...s }));
  const current = s => (s.useShort ? s.short : s.text);
  const width = () => live.reduce((w, s) => w + visibleWidth(current(s)), 0) + GAP.length * (live.length - 1);
  const steps = live
    .flatMap(s => [
      s.short && { at: s.prio - 30, apply: () => (s.useShort = true) },
      { at: s.prio, apply: () => live.splice(live.indexOf(s), 1) },
    ])
    .filter(Boolean)
    .sort((a, b) => a.at - b.at);
  for (const step of steps) {
    if (maxWidth <= 0 || live.length <= 1 || width() <= maxWidth) break;
    step.apply();
  }
  return live.map(current);
}

// env lets tests replace the clock, the terminal width and the two sources that touch
// the machine (git and the account file).
export function render(data, env = {}) {
  const {
    now = Date.now(),
    columns = Number(process.env.COLUMNS) || 0,
    git = gitInfo,
    account = accountEmail,
  } = env;
  const profile = profileDir(data);
  const dir = data.workspace?.current_dir || data.cwd || '';

  const segs = [
    data.session_name && { prio: 60, text: `🔖 ${data.session_name}` },
    segProject(data),
    segBranch(dir ? git(dir) : null, data.worktree?.name),
    segEngine(data),
    segContext(data),
    segBudget(data, now),
    segAccount(profile, account(profile)),
  ].filter(Boolean);

  // 6 columns of margin for the padding Claude Code puts around the status line
  return fit(segs, columns - 6).join(GAP);
}

// ---- entry point --------------------------------------------------------------------------

function isMain() {
  if (!process.argv[1]) return false;
  try {
    const a = fs.realpathSync(process.argv[1]);
    const b = fs.realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isMain()) {
  let input = '';
  // if stdin never closes, an empty status line beats a process left hanging
  setTimeout(() => process.exit(0), 3000).unref();
  process.stdin.on('data', chunk => (input += chunk));
  process.stdin.on('end', () => {
    let data;
    try {
      // a leading BOM makes JSON.parse throw
      data = JSON.parse(input.charCodeAt(0) === 0xfeff ? input.slice(1) : input);
    } catch {
      return;
    }
    // Debug: while <profile>/statusline.debug exists, keep a copy of the input, which is
    // the quickest way to discover fields added by a new Claude Code release.
    try {
      if (fs.existsSync(path.join(profileDir(data), 'statusline.debug'))) {
        fs.writeFileSync(path.join(os.tmpdir(), 'claude-statusline-input.json'), JSON.stringify(data, null, 2));
      }
    } catch {}
    try {
      console.log(render(data));
    } catch (err) {
      // a bug must not make the status line vanish: show the bare minimum and the error
      const dir = path.basename(data.workspace?.current_dir || data.cwd || '');
      console.log(`📁 ${dir}${GAP}🤖 ${data.model?.display_name || '?'}${GAP}${dim(`⚠ statusline: ${err.message}`)}`);
    }
  });
}
