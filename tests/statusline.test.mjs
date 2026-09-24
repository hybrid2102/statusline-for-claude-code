import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assessWindows,
  changesSince,
  checkForUpdate,
  fit,
  formatDuration,
  formatTokens,
  isNewer,
  parseGitStatus,
  parseVersion,
  profileDir,
  render,
  selfUpdate,
  updateAvailable,
  visibleWidth,
} from '../statusline.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'statusline.mjs');
const fixture = () => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'input.json'), 'utf8'));

const plain = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
// half-way through the fixture's 5-hour window
const NOW = 1790000000 * 1000 - 2.5 * HOUR;

const cleanRepo = { branch: 'main', ahead: 0, behind: 0, gone: false, changes: 0, conflicts: 0, op: '' };
const renderWith = (data, env = {}) =>
  render(data, { now: NOW, columns: 0, git: () => cleanRepo, account: () => 'dev@example.com', update: () => null, ...env });

describe('formatTokens', () => {
  it('uses k and M with sensible rounding', () => {
    assert.equal(formatTokens(950), '950');
    assert.equal(formatTokens(62400), '62k');
    assert.equal(formatTokens(1000000), '1M');
    assert.equal(formatTokens(1250000), '1.3M');
  });
});

describe('formatDuration', () => {
  it('switches unit at one hour and one day', () => {
    assert.equal(formatDuration(42 * 60e3), '42m');
    assert.equal(formatDuration(HOUR), '1h00m');
    assert.equal(formatDuration(2 * HOUR + 5 * 60e3), '2h05m');
    assert.equal(formatDuration(3 * DAY + 12 * HOUR), '3d12h');
  });

  it('never goes negative', () => {
    assert.equal(formatDuration(-5000), '0m');
  });
});

describe('visibleWidth', () => {
  it('ignores ANSI sequences', () => {
    assert.equal(visibleWidth('\x1b[31mabc\x1b[0m'), 3);
  });

  it('counts emoji as two columns, including those made so by a variation selector', () => {
    assert.equal(visibleWidth('🟢a'), 3);
    assert.equal(visibleWidth(`⚠${String.fromCodePoint(0xfe0f)}x`), 3);
  });

  it('counts text-style arrows as one column', () => {
    assert.equal(visibleWidth('↗↺→'), 3);
  });
});

describe('parseGitStatus', () => {
  it('reads branch, upstream distance and changes', () => {
    const g = parseGitStatus('## main...origin/main [ahead 2, behind 1]\n M a.txt\n?? b.txt\n');
    assert.deepEqual(g, { branch: 'main', ahead: 2, behind: 1, gone: false, changes: 2, conflicts: 0 });
  });

  it('counts conflicts separately', () => {
    const g = parseGitStatus('## feature\nUU a.txt\nAA b.txt\n M c.txt\n');
    assert.equal(g.conflicts, 2);
    assert.equal(g.changes, 3);
  });

  it('handles a fresh repository, a detached HEAD and a deleted upstream', () => {
    assert.equal(parseGitStatus('## No commits yet on main\n').branch, 'main');
    assert.equal(parseGitStatus('## HEAD (no branch)\n').branch, 'detached');
    assert.equal(parseGitStatus('## topic...origin/topic [gone]\n').gone, true);
  });

  it('returns null for anything that is not porcelain output', () => {
    assert.equal(parseGitStatus(''), null);
    assert.equal(parseGitStatus('fatal: not a git repository'), null);
  });
});

describe('assessWindows', () => {
  const at = (used, remainingMs) => ({ used_percentage: used, resets_at: (NOW + remainingMs) / 1000 });

  it('projects usage at reset from the pace so far', () => {
    const [w] = assessWindows({ five_hour: at(20, 2.5 * HOUR) }, NOW);
    assert.equal(Math.round(w.projection), 40);
    assert.equal(w.light, 'green');
  });

  it('turns yellow when the projection lands between 70% and 100%', () => {
    const [w] = assessWindows({ five_hour: at(60, 1.25 * HOUR) }, NOW);
    assert.equal(Math.round(w.projection), 80);
    assert.equal(w.light, 'yellow');
  });

  it('turns red when the budget would run out before the reset', () => {
    // 50% used after two of seven days
    const [w] = assessWindows({ seven_day: at(50, 5 * DAY) }, NOW);
    assert.equal(Math.round(w.projection), 175);
    assert.equal(w.light, 'red');
  });

  it('does not project in the first 10% of a window, and judges usage more cautiously', () => {
    const [w] = assessWindows({ five_hour: at(85, 4.8 * HOUR) }, NOW);
    assert.equal(w.projection, null);
    assert.equal(w.light, 'red'); // 85% of a window that has barely started
  });

  it('treats an expired window as empty', () => {
    const [w] = assessWindows({ five_hour: at(97, -10 * 60e3) }, NOW);
    assert.equal(w.used, 0);
    assert.equal(w.resetsInMs, null);
    assert.equal(w.light, 'green');
  });

  it('accepts resets_at in milliseconds and as an ISO string', () => {
    const end = NOW + 2.5 * HOUR;
    const ms = assessWindows({ five_hour: { used_percentage: 20, resets_at: end } }, NOW)[0];
    const iso = assessWindows({ five_hour: { used_percentage: 20, resets_at: new Date(end).toISOString() } }, NOW)[0];
    assert.equal(Math.round(ms.projection), 40);
    assert.equal(Math.round(iso.projection), 40);
  });

  it('skips windows that are missing', () => {
    assert.deepEqual(assessWindows(undefined, NOW), []);
    assert.equal(assessWindows({ seven_day: at(10, DAY) }, NOW).length, 1);
  });
});

describe('fit', () => {
  const segs = [
    { prio: 100, text: 'AAAAAAAAAA', short: 'A' },
    { prio: 85, text: 'BBBBBBBBBB' },
    { prio: 95, text: 'CCCCCCCCCC', short: 'C' },
  ];

  it('leaves the line alone when it fits or when the width is unknown', () => {
    assert.deepEqual(fit(segs, 100), ['AAAAAAAAAA', 'BBBBBBBBBB', 'CCCCCCCCCC']);
    assert.deepEqual(fit(segs, -6), ['AAAAAAAAAA', 'BBBBBBBBBB', 'CCCCCCCCCC']);
  });

  it('shortens a more important segment before dropping a less important one', () => {
    // C shortens at 65, before B is dropped at 85
    assert.deepEqual(fit(segs, 30), ['AAAAAAAAAA', 'BBBBBBBBBB', 'C']);
  });

  it('drops segments by priority once shortening is not enough', () => {
    // A shortens at 70, still before B is dropped at 85
    assert.deepEqual(fit(segs, 14), ['A', 'C']);
  });

  it('always keeps at least one segment', () => {
    assert.deepEqual(fit(segs, 1), ['A']);
  });

  it('does not modify its input', () => {
    fit(segs, 1);
    assert.equal(segs.length, 3);
    assert.equal(segs[2].useShort, undefined);
  });
});

describe('profileDir', () => {
  it('derives the profile from the transcript path', () => {
    const data = { transcript_path: path.join('/home/dev/.claude-work', 'projects', 'slug', 'id.jsonl') };
    assert.equal(profileDir(data), path.join('/home/dev/.claude-work'));
  });
});

describe('render', () => {
  it('produces the full line in a calm state, with no colour but the budget light', () => {
    const line = renderWith(fixture());
    assert.equal(
      plain(line),
      '🔖 refactor billing  📁 acme-web  🌿 main  🤖 Opus 5.5 · high  🧠 111k 11%  ' +
        '🟢 5h 20%→40% (2h30m) · 7d 25%→51% (3d13h)  👤 dev'
    );
    assert.ok(!line.includes(RED) && !line.includes(YELLOW), 'a calm state must not use red or yellow');
  });

  it('lights up exactly what needs attention', () => {
    const data = fixture();
    data.context_window.used_percentage = 31;
    data.context_window.current_usage.cache_read_input_tokens = 305563;
    data.prompt_cache.warm = false;
    data.prompt_cache.recache_tokens_if_cold = 310000;
    data.rate_limits.seven_day = { used_percentage: 50, resets_at: (NOW + 5 * DAY) / 1000 };
    const line = renderWith(data);
    assert.match(plain(line), /🧠 310k 31% ❄ 310k/);
    assert.match(plain(line), /^.*🔴 5h/);
    assert.ok(line.includes(`${YELLOW}310k`), 'a context past 200k tokens is yellow');
    assert.ok(line.includes(`${RED}175%`), 'a projection past 100% is red');
  });

  it('shows git state, and red only for what blocks', () => {
    const git = () => ({ ...cleanRepo, changes: 9, ahead: 2, conflicts: 1, op: 'REBASE' });
    const line = renderWith(fixture(), { git });
    assert.match(plain(line), /🌿 main \*9 ↑2 REBASE !1/);
    assert.ok(line.includes(`${RED}REBASE !1`));
  });

  it('names the worktree next to the branch', () => {
    const data = { ...fixture(), worktree: { name: 'hotfix' } };
    assert.match(plain(renderWith(data)), /🌿 main 🌳 hotfix/);
  });

  it('shows the sub-folder when working inside the project', () => {
    const data = fixture();
    data.workspace.current_dir = path.join(data.workspace.project_dir, 'src', 'billing', 'api');
    assert.match(plain(renderWith(data)), /📁 acme-web\/src\/…\/api/);
  });

  it('falls back to dollars on a pay-as-you-go account', () => {
    const data = fixture();
    delete data.rate_limits;
    assert.match(plain(renderWith(data)), /💰 \$0\.29/);
  });

  it('keeps the budget when the terminal is narrow', () => {
    const line = plain(renderWith(fixture(), { columns: 60 }));
    assert.ok(visibleWidth(line) <= 54, `too wide: ${line}`);
    assert.match(line, /🟢/);
    assert.match(line, /📁 acme-web/);
  });

  it('advertises a newer release, and gives it up first when the terminal is narrow', () => {
    const update = () => '9.9.9';
    assert.match(plain(renderWith(fixture(), { update })), /👤 dev  🆕 v9\.9\.9 \/statusline-update$/);
    assert.doesNotMatch(plain(renderWith(fixture(), { update, columns: 120 })), /statusline-update/);
  });

  it('survives a nearly empty input', () => {
    // with no transcript path the profile comes from CLAUDE_CONFIG_DIR, which would name
    // whatever profile the tests happen to run under
    const saved = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      assert.equal(plain(renderWith({})), '📁 ?  🤖 ?  👤 dev');
    } finally {
      if (saved !== undefined) process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });
});

describe('command line', () => {
  // no update check: it would reach GitHub and leave a cache file in the repository
  const env = { ...process.env, COLUMNS: '', STATUSLINE_NO_UPDATE_CHECK: '1' };
  const run = input => spawnSync(process.execPath, [script], { input, encoding: 'utf8', env });

  it('prints one line for a real input', () => {
    const r = run(fs.readFileSync(path.join(here, 'fixtures', 'input.json')));
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim().split('\n').length, 1);
    assert.match(plain(r.stdout), /🤖 Opus 5\.5/);
  });

  it('accepts input with a byte order mark', () => {
    const r = run(String.fromCharCode(0xfeff) + '{"model":{"display_name":"BOM"}}');
    assert.match(plain(r.stdout), /🤖 BOM/);
  });

  it('prints nothing and exits cleanly on invalid input', () => {
    const r = run('not json');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('prints its version', () => {
    const r = spawnSync(process.execPath, [script, '--version'], { encoding: 'utf8', env });
    assert.equal(r.stdout.trim(), parseVersion(fs.readFileSync(script, 'utf8')));
  });

  it('does nothing when imported rather than run', () => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../statusline.mjs', import.meta.url).href)})`], {
      input: '{}',
      encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

describe('updates', () => {
  const source = fs.readFileSync(script, 'utf8');
  const versioned = v => source.replace(/^\/\/ version: .*$/m, `// version: ${v}`);
  const sha = text => crypto.createHash('sha256').update(text).digest('hex');

  // a folder of its own holding an installed script of the given version
  const dirs = [];
  after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));
  const install = version => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-test-'));
    dirs.push(dir);
    const file = path.join(dir, 'statusline.mjs');
    fs.writeFileSync(file, versioned(version));
    return { dir, file };
  };

  // GitHub as seen through fetch: `files` maps the end of a URL to its body
  const github = files => async url => {
    const key = Object.keys(files).find(k => url.endsWith(k));
    return key === undefined
      ? { ok: false, status: 404 }
      : { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(files[key]).buffer };
  };
  const release = (version, body = versioned(version), sums = `${sha(body)}  statusline.mjs\n`) =>
    github({
      '/releases/latest': JSON.stringify({ tag_name: `v${version}` }),
      [`v${version}/statusline.mjs`]: body,
      [`v${version}/SHA256SUMS.txt`]: sums,
      [`v${version}/CHANGELOG.md`]: '# Changelog\n\n## [Unreleased]\n\n## [9.0.0] - x\n\n- new\n\n## [1.0.0] - x\n\n- old\n',
    });
  const noTest = () => {};

  it('compares versions numerically', () => {
    assert.equal(isNewer('1.10.0', '1.9.9'), true);
    assert.equal(isNewer('1.2.0', '1.2.0'), false);
    assert.equal(isNewer('0.9.0', '1.0.0'), false);
  });

  it('extracts the changelog of the releases after a version', () => {
    const log = '# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - x\n\n- b\n\n## [1.1.0] - x\n\n- a\n';
    assert.equal(changesSince(log, '1.1.0'), '## [1.2.0] - x\n\n- b');
  });

  it('replaces the script with a verified newer release and keeps a backup', async () => {
    const { dir, file } = install('1.0.0');
    const report = await selfUpdate({ get: release('9.0.0'), file, test: noTest });
    assert.equal(parseVersion(fs.readFileSync(file, 'utf8')), '9.0.0');
    assert.equal(parseVersion(fs.readFileSync(`${file}.bak-1.0.0`, 'utf8')), '1.0.0');
    assert.match(report, /from 1\.0\.0 to 9\.0\.0/);
    assert.match(report, /## \[9\.0\.0\]/);
    assert.doesNotMatch(report, /## \[1\.0\.0\]/);
    assert.ok(!fs.existsSync(path.join(dir, 'statusline.new.mjs')));
  });

  it('runs the new version before installing it', async () => {
    const { file } = install('1.0.0');
    await selfUpdate({ get: release('9.0.0'), file });
    assert.equal(parseVersion(fs.readFileSync(file, 'utf8')), '9.0.0');

    const { dir, file: other } = install('1.0.0');
    const broken = versioned('9.1.0') + '\nsyntax error(';
    await assert.rejects(selfUpdate({ get: release('9.1.0', broken), file: other }), /does not run/);
    assert.equal(fs.readFileSync(other, 'utf8'), versioned('1.0.0'));
    assert.ok(!fs.existsSync(path.join(dir, 'statusline.new.mjs')));
  });

  it('refuses a download that does not match its checksum or its tag', async () => {
    const { file } = install('1.0.0');
    const tampered = release('9.0.0', versioned('9.0.0'), `${'0'.repeat(64)}  statusline.mjs\n`);
    await assert.rejects(selfUpdate({ get: tampered, file, test: noTest }), /SHA256SUMS/);
    await assert.rejects(selfUpdate({ get: release('9.0.0', versioned('8.0.0')), file, test: noTest }), /does not say version 9\.0\.0/);
    assert.equal(fs.readFileSync(file, 'utf8'), versioned('1.0.0'));
  });

  it('leaves an up-to-date or newer script alone', async () => {
    const { file } = install('9.0.0');
    assert.match(await selfUpdate({ get: release('9.0.0'), file, test: noTest }), /up to date/);
    const { file: dev } = install('10.0.0');
    assert.match(await selfUpdate({ get: release('9.0.0'), file: dev, test: noTest }), /newer than the latest release/);
    assert.equal(fs.readFileSync(dev, 'utf8'), versioned('10.0.0'));
  });

  it('checks at most once a day, in the background, and reports what the last check found', async () => {
    const { file } = install('1.0.0');
    let started = 0;
    const start = () => started++;
    assert.equal(updateAvailable(NOW, { file, start }), null);
    assert.equal(updateAvailable(NOW + HOUR, { file, start }), null);
    assert.equal(started, 1, 'a check is already under way');

    await checkForUpdate({ get: release('9.0.0'), file, now: NOW + HOUR });
    assert.equal(updateAvailable(NOW + 2 * HOUR, { file, start }), '9.0.0');
    assert.equal(started, 1);
    updateAvailable(NOW + 2 * DAY, { file, start });
    assert.equal(started, 2);
  });

  it('can be turned off', () => {
    const { file } = install('1.0.0');
    let started = 0;
    process.env.STATUSLINE_NO_UPDATE_CHECK = '1';
    try {
      assert.equal(updateAvailable(NOW, { file, start: () => started++ }), null);
    } finally {
      delete process.env.STATUSLINE_NO_UPDATE_CHECK;
    }
    assert.equal(started, 0);
  });

  it('exits 0 from a failed --update, so the command can report the failure', () => {
    const { file } = install('1.0.0');
    // an invalid URL makes fetch fail at once, without touching the network
    fs.writeFileSync(file, versioned('1.0.0').replace('https://api.github.com', 'http://['));
    const r = spawnSync(process.execPath, [file, '--update'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /was not updated/);
  });
});
