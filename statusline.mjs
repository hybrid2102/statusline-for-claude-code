#!/usr/bin/env node
// version: 1.4.0
//
// A status line for Claude Code that answers five questions at a glance:
//
//   whose budget        👤 account                    -> shown first, kept longest
//   where am I          📁 project   🌿 branch        -> am I working in the right place?
//   with what           🤖 model · effort · advisor   -> the levers that decide consumption
//   what does it cost   🧠 context   ❄ cold cache     -> how heavy is the next message?
//   what is left        🟢 5h · 7d                    -> can I push harder or should I slow down?
//
// Two rules shape everything below. Every segment must lead to a decision, or it is not
// shown. And colour means "look here": in normal conditions the line is almost entirely
// grey, so anything that lights up deserves attention.
//
// Claude Code pipes a JSON document on stdin and shows the first line printed on stdout.
// https://code.claude.com/docs/en/statusline

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
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

// Cuts plain text (never a string with ANSI codes) to at most max columns, marking the cut
// with "…". With middle, the end is kept too: branch names differ mostly in their tail.
export const truncate = (text, max, middle = false) => {
  if (visibleWidth(text) <= max) return text;
  const chars = [...text];
  const take = (list, cols) => {
    const out = [];
    for (const c of list) {
      if (visibleWidth(out.join('') + c) > cols) break;
      out.push(c);
    }
    return out;
  };
  if (!middle) return take(chars, max - 1).join('') + '…';
  const head = take(chars, Math.ceil((max - 1) / 2));
  const tail = take([...chars].reverse(), max - 1 - visibleWidth(head.join(''))).reverse();
  return head.join('') + '…' + tail.join('');
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

// The advisor model, if one is set. Claude Code does not put it in the status line input,
// so it is read from the settings files, the most specific first: project local, project,
// then the profile. A per-session `--advisor` flag leaves no trace there and cannot be seen.
export function advisorModel(profile, dir) {
  const out = [];
  for (let d = dir; d; d = path.dirname(d)) {
    out.push(path.join(d, '.claude', 'settings.local.json'), path.join(d, '.claude', 'settings.json'));
    if (path.dirname(d) === d) break;
  }
  for (const p of [...out, path.join(profile, 'settings.json')]) {
    try {
      const v = JSON.parse(fs.readFileSync(p, 'utf8')).advisorModel;
      if (typeof v === 'string') return v;
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
// Each returns { prio, forms } or nothing: forms go from the full text to the most compact
// one that still says something. See fit() for how prio and forms are used. A compact form
// keeps the warnings: red and yellow, ⚡ and ❄ stay until the segment itself goes (of
// several git alarms, the first one).

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
  return {
    prio: 100,
    forms: [`📁 ${where}${extra ? dim(` +${extra}`) : ''}`, `📁 ${base}`, `📁 ${truncate(base, 12)}`],
  };
}

function segBranch(g, worktree) {
  if (!g) return;
  // in a worktree the same repository is open in several folders: the name says which
  const name = (branch, wt) => `🌿 ${branch}${worktree ? ` 🌳 ${wt}` : ''}`;
  // Pending changes and ahead/behind are the normal state of work, so they stay grey.
  // Red is kept for what blocks you: conflicts, an operation left half-way, a lost upstream.
  const alarm = [g.op, g.conflicts && `!${g.conflicts}`, g.gone && 'upstream gone'].filter(Boolean);
  const sync = `${g.ahead ? `↑${g.ahead}` : ''}${g.behind ? `↓${g.behind}` : ''}`;
  const state = [g.changes && `*${g.changes}`, sync].filter(Boolean).join(' ');
  const alarmAll = alarm.length ? ' ' + paint(RED, alarm.join(' ')) : '';
  const alarmFirst = alarm.length ? ' ' + paint(RED, alarm[0]) : '';
  const full = name(g.branch, worktree);
  return {
    prio: 85,
    forms: [
      `${full}${state ? ' ' + dim(state) : ''}${alarmAll}`,
      `${full}${alarmAll}`,
      `${full}${alarmFirst}`,
      name(truncate(g.branch, 18, true), truncate(worktree || '', 10, true)) + alarmFirst,
      name(truncate(g.branch, 10, true), truncate(worktree || '', 6, true)) + alarmFirst,
    ],
  };
}

function segEngine(data, advisor) {
  const model = data.model?.display_name || data.model?.id || '?';
  const extras = [
    data.effort?.level,
    advisor && `advisor ${advisor}`,
    data.thinking?.enabled === false && 'no-think',
    data.output_style?.name && data.output_style.name !== 'default' && data.output_style.name,
  ].filter(Boolean);
  // fast mode costs more: the only engine setting that earns a colour
  const fast = data.fast_mode ? ' ' + paint(YELLOW, '⚡') : '';
  const withExtras = list => `🤖 ${model}${fast}${list.length ? dim(' · ' + list.join(' · ')) : ''}`;
  // the effort is the lever you touch most often, so it is the last extra to go;
  // then the version number of the model, which rarely changes during a session
  return {
    prio: 95,
    forms: [
      withExtras(extras),
      withExtras(extras.slice(0, data.effort?.level ? 1 : 0)),
      `🤖 ${model}${fast}`,
      `🤖 ${model.split(' ')[0]}${fast}`,
    ],
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
    forms: [
      `🧠 ${size}${cold ? ' ' + paint(YELLOW, `❄ ${formatTokens(pc.recache_tokens_if_cold)}`) : ''}`,
      `🧠 ${size}${cold ? ' ' + paint(YELLOW, '❄') : ''}`,
      `🧠 ${paint(color, pctText)}${cold ? ' ' + paint(YELLOW, '❄') : ''}`,
    ],
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
    return cost != null ? { prio: 98, forms: [`💰 $${cost.toFixed(2)}`] } : undefined;
  }
  const COLOR = { green: '', yellow: YELLOW, red: RED };
  const LIGHT = { green: '🟢', yellow: '🟡', red: '🔴' };
  const worst = windows.reduce((a, b) => (a.risk >= b.risk ? a : b));
  const show = (w, withReset) => {
    const c = COLOR[w.light];
    const proj = w.projection != null ? dim('→') + paint(c, `${Math.min(999, Math.round(w.projection))}%`) : '';
    const reset = withReset && w.resetsInMs != null ? dim(` (${formatDuration(w.resetsInMs)})`) : '';
    return `${dim(w.label)} ${paint(c, `${Math.round(w.used)}%`)}${proj}${reset}`;
  };
  const line = (list, withReset) => `${LIGHT[worst.light]} ${list.map(w => show(w, withReset)).join(dim(' · '))}`;
  // both windows for as long as they fit, then the one that decides the light
  return {
    prio: 98,
    forms: [line(windows, true), line(windows, false), line([worst], true), line([worst], false)],
  };
}

// Whose budget is being spent, shown first. With several profiles open in different windows
// this is the only way to tell them apart; the part before the @ is enough.
function segAccount(profile, email) {
  const name = path.basename(profile);
  const standard = name === '.claude';
  const id = [email.split('@')[0], standard ? '' : name].filter(Boolean).join(' · ');
  if (!id) return;
  // in a profile name only what follows ".claude" tells it from the others
  const short = standard ? id : name;
  const tiny = standard ? truncate(id, 8) : truncate(name.replace(/^\.claude[-_.]?/, '') || name, 8, true);
  return { prio: 97, forms: [`👤 ${dim(id)}`, `👤 ${dim(short)}`, `👤 ${dim(tiny)}`] };
}

function segSession(name) {
  if (!name) return;
  return { prio: 60, forms: [`🔖 ${name}`, `🔖 ${truncate(name, 14)}`, `🔖 ${truncate(name, 9)}`] };
}

// A newer release, with the command that installs it. The most dispensable segment: it
// shortens first and goes before anything else does.
function segUpdate(latest) {
  if (!latest) return;
  return { prio: 30, forms: [`🆕 ${dim(`v${latest} /statusline-update`)}`, `🆕 ${dim(`v${latest}`)}`, '🆕'] };
}

// ---- updates ------------------------------------------------------------------------------

const REPO = 'hybrid2102/statusline-for-claude-code';
const SELF = fileURLToPath(import.meta.url);
const CHECK_EVERY_MS = 24 * 3600e3;
const NO_CHECK_ENV = 'STATUSLINE_NO_UPDATE_CHECK';

export const parseVersion = text => text.match(/^\/\/ version: (\d+\.\d+\.\d+)$/m)?.[1] ?? null;

export const isNewer = (a, b) => {
  const [x, y] = [a, b].map(v => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

// The changelog sections of the releases after `current`, newest first, so that an update
// can say what it brings.
export function changesSince(changelog, current) {
  return changelog
    .split(/^(?=## \[)/m)
    .filter(s => {
      const v = s.match(/^## \[(\d+\.\d+\.\d+)\]/)?.[1];
      return v && (!current || isNewer(v, current));
    })
    .map(s => s.trim())
    .join('\n\n');
}

// The result of the last check lives next to the script, so every profile shares it.
const cacheFile = file => path.join(path.dirname(file), 'statusline-update.json');
const readCache = file => {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(file), 'utf8'));
  } catch {
    return {};
  }
};
const writeCache = (file, cache) => fs.writeFileSync(cacheFile(file), JSON.stringify(cache) + '\n');

// The version a render should advertise, or null. The status line must never wait for the
// network, so at most once a day it starts a detached `--check-update` and shows what the
// previous check found. checkedAt is written before the check starts: renders arrive
// every few hundred milliseconds, and each would otherwise start its own.
export function updateAvailable(now, { file = SELF, start = startCheck } = {}) {
  if (process.env[NO_CHECK_ENV]) return null;
  const cache = readCache(file);
  if (!(cache.checkedAt <= now && now - cache.checkedAt < CHECK_EVERY_MS)) {
    try {
      writeCache(file, { ...cache, checkedAt: now });
      start(file);
    } catch {}
  }
  if (!cache.latest) return null;
  let current;
  try {
    current = parseVersion(fs.readFileSync(file, 'utf8'));
  } catch {}
  return current && isNewer(cache.latest, current) ? cache.latest : null;
}

function startCheck(file) {
  spawn(process.execPath, [file, '--check-update'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function download(get, url, what) {
  const res = await get(url, {
    headers: { 'User-Agent': 'statusline-for-claude-code', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`could not download ${what} (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

async function latestRelease(get) {
  const json = JSON.parse(await download(get, `https://api.github.com/repos/${REPO}/releases/latest`, 'the release list'));
  const version = String(json.tag_name || '').match(/^v(\d+\.\d+\.\d+)$/)?.[1];
  if (!version) throw new Error(`unexpected latest release "${json.tag_name}"`);
  return { tag: json.tag_name, version };
}

export async function checkForUpdate({ get = fetch, file = SELF, now = Date.now() } = {}) {
  const { version } = await latestRelease(get);
  writeCache(file, { checkedAt: now, latest: version });
  return version;
}

// A script that does not run must never replace one that does: the candidate renders a
// sample input before it goes in.
function smokeTest(candidate) {
  const r = spawnSync(process.execPath, [candidate], {
    input: '{"model":{"display_name":"update-check"}}',
    encoding: 'utf8',
    env: { ...process.env, [NO_CHECK_ENV]: '1' },
    timeout: 10000,
    windowsHide: true,
  });
  if (!r.stdout?.includes('update-check')) throw new Error(`the new version does not run: ${(r.stderr || '').trim() || 'no output'}`);
}

// Replaces this script with the latest release, after checking it against the release's
// SHA256SUMS.txt, its own version line and a test run. Returns a report for the user.
export async function selfUpdate({ get = fetch, file = SELF, test = smokeTest, now = Date.now() } = {}) {
  const current = parseVersion(fs.readFileSync(file, 'utf8'));
  const release = await latestRelease(get);
  writeCache(file, { checkedAt: now, latest: release.version });
  if (current && !isNewer(release.version, current)) {
    return current === release.version
      ? `The status line is up to date (version ${current}).`
      : `The installed status line (${current}) is newer than the latest release (${release.version}); left unchanged.`;
  }

  const base = `https://github.com/${REPO}/releases/download/${release.tag}/`;
  const [script, sums] = await Promise.all([
    download(get, base + 'statusline.mjs', 'statusline.mjs'),
    download(get, base + 'SHA256SUMS.txt', 'SHA256SUMS.txt'),
  ]);
  const expected = sums.toString('utf8').match(/^([0-9a-f]{64}) +statusline\.mjs$/m)?.[1];
  if (!expected) throw new Error('SHA256SUMS.txt has no line for statusline.mjs');
  if (crypto.createHash('sha256').update(script).digest('hex') !== expected) {
    throw new Error('the download does not match SHA256SUMS.txt');
  }
  if (parseVersion(script.toString('utf8')) !== release.version) {
    throw new Error(`the downloaded script does not say version ${release.version}`);
  }

  // .mjs, or node would read the candidate as CommonJS and reject its imports
  const candidate = path.join(path.dirname(file), 'statusline.new.mjs');
  fs.writeFileSync(candidate, script);
  try {
    test(candidate);
    const backup = `${file}.bak-${current || 'unversioned'}`;
    fs.copyFileSync(file, backup);
    // On Windows a render reading the file at that instant makes the rename fail
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(candidate, file);
        break;
      } catch (err) {
        if (attempt === 5) throw err;
        await new Promise(r => setTimeout(r, 200));
      }
    }
    let changes = '';
    try {
      const log = await download(get, `https://raw.githubusercontent.com/${REPO}/${release.tag}/CHANGELOG.md`, 'the changelog');
      changes = changesSince(log.toString('utf8'), current);
    } catch {}
    return [
      `Updated the status line from ${current || 'an unversioned copy'} to ${release.version}. ` +
        `The previous version is saved as ${path.basename(backup)}; the new one shows from the next refresh.`,
      changes || `What changed: https://github.com/${REPO}/blob/main/CHANGELOG.md`,
    ].join('\n\n');
  } finally {
    fs.rmSync(candidate, { force: true });
  }
}

// ---- layout -------------------------------------------------------------------------------

// Every segment opens with its own emoji, which already marks where it starts: a plain gap
// is enough between segments and leaves " · " as the only mark, used inside a segment.
const GAP = '  ';

// When the line does not fit, compress before giving anything up. Every segment moves one
// form down, least important first, then every segment a second form, and so on: a hidden
// segment costs more than a terse one. Only when all of them are at their most compact are
// segments dropped, least important first, and the budget is the last to go. Finally the
// room a step left over goes back, most important first: a drop can free more than needed.
// Segments may also be given as { prio, text, short }.
export function fit(segs, maxWidth) {
  const live = segs.map(s => {
    const forms = [];
    for (const f of s.forms || [s.text, s.short]) {
      if (f && (!forms.length || visibleWidth(f) < visibleWidth(forms.at(-1)))) forms.push(f);
    }
    return { prio: s.prio, forms, level: 0, shown: true };
  });
  const result = () => live.filter(s => s.shown).map(s => s.forms[s.level]);
  const fits = () => {
    const shown = result();
    return shown.reduce((w, f) => w + visibleWidth(f), 0) + GAP.length * (shown.length - 1) <= maxWidth;
  };
  if (maxWidth <= 0 || fits()) return result();

  const byPrio = [...live].sort((a, b) => a.prio - b.prio);
  const depth = Math.max(...live.map(s => s.forms.length));
  const steps = [];
  for (let level = 1; level < depth; level++) {
    for (const s of byPrio) if (level < s.forms.length) steps.push({ s, level });
  }
  for (const s of byPrio) steps.push({ s, drop: true });

  const done = [];
  for (const step of steps) {
    if (fits()) break;
    if (step.drop && live.filter(s => s.shown).length <= 1) break;
    if (step.drop) step.s.shown = false;
    else step.s.level = step.level;
    done.push(step);
  }
  // give back what still fits, in the reverse order: dropped segments first, at their most
  // compact, even a less important one when a more important one is too wide to return.
  // A compression that cannot be undone also keeps the earlier ones of the same segment,
  // since its level no longer matches theirs.
  for (const step of done.reverse()) {
    const { s } = step;
    if (step.drop) {
      s.shown = true;
      if (!fits()) s.shown = false;
    } else if (s.level === step.level) {
      s.level--;
      if (!fits()) s.level++;
    }
  }
  return result();
}

// env lets tests replace the clock, the terminal width and the sources that touch the
// machine (git, the account file, the advisor setting and the update check).
export function render(data, env = {}) {
  const {
    now = Date.now(),
    columns = Number(process.env.COLUMNS) || 0,
    git = gitInfo,
    account = accountEmail,
    advisor = advisorModel,
    update = updateAvailable,
  } = env;
  const profile = profileDir(data);
  const dir = data.workspace?.current_dir || data.cwd || '';

  const segs = [
    segAccount(profile, account(profile)),
    segSession(data.session_name),
    segProject(data),
    segBranch(dir ? git(dir) : null, data.worktree?.name),
    segEngine(data, advisor(profile, dir)),
    segContext(data),
    segBudget(data, now),
    segUpdate(update(now)),
  ].filter(Boolean);

  // 6 columns of margin for the padding Claude Code puts around the status line
  return fit(segs, columns - 6).join(GAP);
}

// ---- Orca ---------------------------------------------------------------------------------

// Orca (https://github.com/stablyai/orca) reads the 5h and 7d windows from the status line
// input instead of polling the usage endpoint. It only installs its own status line when the
// slot is empty, so with this one in place it would go blind: the windows are passed on to
// it, the way its own script does. Only rate_limits is sent, the one field Orca reads.
// https://github.com/stablyai/orca/blob/main/src/main/claude/hooks/statusline-script.ts
const ORCA_PATH = '/statusline/claude';
// renders arrive several times a second; Orca's own script posts at most every 15 seconds
const ORCA_EVERY_MS = 15e3;

// The pane to report for, or null when this session does not run inside Orca. Claude
// background jobs inherit the pane of the session that started them, so they are skipped.
export function orcaPane(data, env = process.env) {
  if (!env.ORCA_PANE_KEY || env.CLAUDE_JOB_DIR) return null;
  const rl = data.rate_limits;
  return rl && typeof rl === 'object' && (rl.five_hour || rl.seven_day) ? env.ORCA_PANE_KEY : null;
}

// Whether this render should post, keeping one timestamp per pane in the temp folder. The
// timestamp is written before the post starts, so that the next renders do not start one too.
export function orcaDue(pane, now, dir = os.tmpdir()) {
  const id = crypto.createHash('sha256').update(pane).digest('hex').slice(0, 16);
  const stamp = path.join(dir, `claude-statusline-orca-${id}`);
  try {
    const last = Number(fs.readFileSync(stamp, 'utf8'));
    if (last <= now && now - last < ORCA_EVERY_MS) return false;
  } catch {}
  try {
    fs.writeFileSync(stamp, String(now));
  } catch {}
  return true;
}

// Orca writes its port and token to a file as well, which outlives a restart of Orca, while
// the environment of a running session does not: the file wins when it can be read. Its
// lines are KEY=VALUE, prefixed with "set " on Windows.
export function orcaEndpoint(env = process.env) {
  const out = {};
  for (const k of ['ORCA_AGENT_HOOK_PORT', 'ORCA_AGENT_HOOK_TOKEN', 'ORCA_AGENT_HOOK_ENV', 'ORCA_AGENT_HOOK_VERSION']) {
    if (env[k]) out[k] = env[k];
  }
  if (env.ORCA_AGENT_HOOK_ENDPOINT) {
    try {
      for (const line of fs.readFileSync(env.ORCA_AGENT_HOOK_ENDPOINT, 'utf8').split(/\r?\n/)) {
        const m = /^(?:set\s+)?(ORCA_AGENT_HOOK_[A-Z_]+)=(.*)$/i.exec(line.trim());
        if (m) out[m[1].toUpperCase()] = m[2];
      }
    } catch {}
  }
  return out;
}

// The post itself, run by a detached `--orca-forward` so the render never waits for it.
// Every failure is silent: Orca being closed must not show up on the status line.
export async function forwardToOrca(rateLimits, { env = process.env, post = fetch } = {}) {
  const ep = orcaEndpoint(env);
  if (!env.ORCA_PANE_KEY || !/^\d+$/.test(ep.ORCA_AGENT_HOOK_PORT || '') || !ep.ORCA_AGENT_HOOK_TOKEN) return false;
  const body = new URLSearchParams({
    paneKey: env.ORCA_PANE_KEY,
    configDir: env.CLAUDE_CONFIG_DIR || '',
    env: ep.ORCA_AGENT_HOOK_ENV || '',
    version: ep.ORCA_AGENT_HOOK_VERSION || '',
    payload: JSON.stringify({ rate_limits: rateLimits }),
  });
  try {
    const res = await post(`http://127.0.0.1:${ep.ORCA_AGENT_HOOK_PORT}${ORCA_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Orca-Agent-Hook-Token': ep.ORCA_AGENT_HOOK_TOKEN },
      body: body.toString(),
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function startOrcaForward(rateLimits) {
  spawn(process.execPath, [SELF, '--orca-forward', JSON.stringify(rateLimits)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
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

// --update and --check-update always exit 0: a non-zero exit would abort the
// /statusline-update command before Claude could report what went wrong.
const main = isMain();
const flag = main ? process.argv[2] : undefined;
if (flag === '--version') {
  console.log(parseVersion(fs.readFileSync(SELF, 'utf8')) || 'unversioned');
} else if (flag === '--update') {
  selfUpdate().then(console.log, err => console.log(`The status line was not updated: ${err.message}`));
} else if (flag === '--check-update') {
  checkForUpdate().catch(() => {});
} else if (flag === '--orca-forward') {
  try {
    forwardToOrca(JSON.parse(process.argv[3])).catch(() => {});
  } catch {}
} else if (main) {
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
    try {
      const pane = orcaPane(data);
      if (pane && orcaDue(pane, Date.now())) startOrcaForward(data.rate_limits);
    } catch {}
  });
}
