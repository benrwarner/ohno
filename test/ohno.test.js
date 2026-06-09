import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/ohno.js', import.meta.url));

function makeWorld() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ohno-proj-')));
  const data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ohno-data-')));
  const ohno = (...args) =>
    execFileSync(process.execPath, [BIN, ...args], {
      cwd: project,
      encoding: 'utf8',
      env: { ...process.env, OHNO_DIR: data, NO_COLOR: '1' },
    });
  return { project, data, ohno };
}

const write = (root, rel, content) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('snap records a snapshot and dedupes no-op snaps', () => {
  const { project, ohno } = makeWorld();
  write(project, 'a.txt', 'hello\n');
  const out = ohno('snap');
  assert.match(out, /Snapshot [0-9a-f]{7}/);
  const again = ohno('snap');
  assert.match(again, /Nothing new to snapshot/);
});

test('log shows the timeline with labels', () => {
  const { project, ohno } = makeWorld();
  write(project, 'a.txt', 'one\n');
  ohno('snap', '-m', 'first');
  write(project, 'a.txt', 'two\n');
  ohno('snap', '-m', 'second');
  const out = ohno('log');
  assert.match(out, /first/);
  assert.match(out, /second/);
});

test('undo restores modified files and deletes files created since the snapshot', () => {
  const { project, ohno } = makeWorld();
  write(project, 'src/app.js', 'original\n');
  ohno('snap', '-m', 'good state');
  write(project, 'src/app.js', 'wrecked by an agent\n');
  write(project, 'src/junk/extra.js', 'should disappear\n');
  const out = ohno('undo');
  assert.match(out, /Restored to [0-9a-f]{7}/);
  assert.equal(read(project, 'src/app.js'), 'original\n');
  assert.equal(fs.existsSync(path.join(project, 'src/junk')), false);
});

test('undo is itself undoable via redo', () => {
  const { project, ohno } = makeWorld();
  write(project, 'a.txt', 'v1\n');
  ohno('snap');
  write(project, 'a.txt', 'v2\n');
  ohno('undo');
  assert.equal(read(project, 'a.txt'), 'v1\n');
  ohno('redo');
  assert.equal(read(project, 'a.txt'), 'v2\n');
});

test('undo restores deleted files', () => {
  const { project, ohno } = makeWorld();
  write(project, 'keep.txt', 'precious\n');
  ohno('snap');
  fs.rmSync(path.join(project, 'keep.txt'));
  ohno('undo');
  assert.equal(read(project, 'keep.txt'), 'precious\n');
});

test('undo <id> time-travels to an older snapshot', () => {
  const { project, ohno } = makeWorld();
  write(project, 'a.txt', 'v1\n');
  ohno('snap', '-m', 'v1');
  write(project, 'a.txt', 'v2\n');
  ohno('snap', '-m', 'v2');
  const log = ohno('log');
  const v1 = log.split('\n').find((l) => l.includes(' v1 ') || l.endsWith('v1') || /\bv1\b/.test(l));
  const id = v1.trim().split(/\s+/)[0];
  ohno('undo', id);
  assert.equal(read(project, 'a.txt'), 'v1\n');
});

test('restore brings back a single file without touching others', () => {
  const { project, ohno } = makeWorld();
  write(project, 'a.txt', 'a-v1\n');
  write(project, 'b.txt', 'b-v1\n');
  ohno('snap', '-m', 'base');
  write(project, 'a.txt', 'a-v2\n');
  write(project, 'b.txt', 'b-v2\n');
  const log = ohno('log');
  const id = log.split('\n').find((l) => l.includes('base')).trim().split(/\s+/)[0];
  ohno('restore', id, 'a.txt');
  assert.equal(read(project, 'a.txt'), 'a-v1\n');
  assert.equal(read(project, 'b.txt'), 'b-v2\n');
});

test('.gitignore is respected — ignored files are never snapshotted', () => {
  const { project, ohno } = makeWorld();
  write(project, '.gitignore', 'secret.txt\n');
  write(project, 'secret.txt', 'do not record\n');
  write(project, 'code.js', 'v1\n');
  ohno('snap');
  write(project, 'code.js', 'v2\n');
  write(project, 'secret.txt', 'still private\n');
  ohno('undo');
  assert.equal(read(project, 'code.js'), 'v1\n');
  // ignored file is untouched by undo, not reverted
  assert.equal(read(project, 'secret.txt'), 'still private\n');
});

test('never touches the real git repository', () => {
  const { project, ohno } = makeWorld();
  const realGit = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8' });
  realGit('init', '-q', '-b', 'main');
  write(project, 'tracked.txt', 'v1\n');
  realGit('add', '-A');
  realGit('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'real commit');

  write(project, 'tracked.txt', 'v2\n');
  ohno('snap');
  write(project, 'tracked.txt', 'v3\n');
  ohno('undo');

  assert.equal(read(project, 'tracked.txt'), 'v2\n');
  // real repo still healthy: one commit, .git intact, only the expected
  // working-tree modification visible (v2 vs the committed v1)
  assert.equal(realGit('rev-list', '--count', 'HEAD').trim(), '1');
  assert.equal(realGit('status', '--porcelain').trim(), 'M tracked.txt');
  assert.equal(fs.existsSync(path.join(project, '.git', 'HEAD')), true);
});

test('diff shows changes against the last snapshot', () => {
  const { project, ohno } = makeWorld();
  write(project, 'a.txt', 'old line\n');
  ohno('snap');
  write(project, 'a.txt', 'new line\n');
  const out = ohno('diff');
  assert.match(out, /-old line/);
  assert.match(out, /\+new line/);
});

test('install claude writes an idempotent PreToolUse hook', () => {
  const { project, ohno } = makeWorld();
  ohno('install', 'claude');
  const settings = JSON.parse(read(project, '.claude/settings.json'));
  const json = JSON.stringify(settings.hooks.PreToolUse);
  assert.match(json, /ohno snap/);
  ohno('install', 'claude'); // second run must not duplicate
  const after = JSON.parse(read(project, '.claude/settings.json'));
  assert.equal(after.hooks.PreToolUse.length, settings.hooks.PreToolUse.length);
});

test('status onboards new projects and reports drift on existing ones', () => {
  const { project, ohno } = makeWorld();
  assert.match(ohno(), /not protecting this project yet/);
  write(project, 'a.txt', 'v1\n');
  ohno('snap');
  assert.match(ohno(), /Clean — working tree matches/);
  write(project, 'a.txt', 'v2\n');
  assert.match(ohno(), /Changed since the last snapshot/);
});

test('reset requires --force and then deletes the shadow repo', () => {
  const { project, ohno } = makeWorld();
  write(project, 'a.txt', 'v1\n');
  ohno('snap');
  const shadow = ohno('path').trim();
  assert.equal(fs.existsSync(shadow), true);
  assert.throws(() => ohno('reset'));
  ohno('reset', '--force');
  assert.equal(fs.existsSync(shadow), false);
});
