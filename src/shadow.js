import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class CliError extends Error {}

export function dataDir() {
  if (process.env.OHNO_DIR) return process.env.OHNO_DIR;
  const xdg = process.env.XDG_DATA_HOME;
  return path.join(xdg || path.join(os.homedir(), '.local', 'share'), 'ohno');
}

// The project root is the real repo's toplevel when inside a git repo,
// otherwise the current directory. One shadow repo per root.
export function projectRoot(cwd = process.cwd()) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  return path.resolve(cwd);
}

export function shadowDir(root) {
  const hash = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
  return path.join(dataDir(), 'repos', hash);
}

// An empty config file to stand in for the user's global git config.
// (Pointing GIT_CONFIG_GLOBAL at the null device breaks on Windows.)
function emptyConfig() {
  const p = path.join(dataDir(), 'noconfig');
  if (!fs.existsSync(p)) {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(p, '');
  }
  return p;
}

// Run git against the shadow repo with the project as the work tree.
// System/global git config is masked so user hooks, gpg signing, fsmonitor,
// etc. can never interfere with (or observe) snapshots.
export function git(root, args, opts = {}) {
  const sd = shadowDir(root);
  return spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
    env: {
      ...process.env,
      GIT_DIR: sd,
      GIT_WORK_TREE: root,
      GIT_INDEX_FILE: path.join(sd, 'index'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: emptyConfig(),
      ...(opts.env || {}),
    },
  });
}

export function gitOrDie(root, args, what) {
  const r = git(root, args);
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || '').trim();
    throw new CliError(`${what || `git ${args[0]} failed`}${detail ? `\n${detail}` : ''}`);
  }
  return r;
}

export function shadowExists(root) {
  return fs.existsSync(path.join(shadowDir(root), 'HEAD'));
}

export function ensureShadow(root) {
  const sd = shadowDir(root);
  if (shadowExists(root)) return sd;
  fs.mkdirSync(sd, { recursive: true });
  gitOrDie(root, ['init', '-q', '-b', 'main'], 'could not initialize the shadow repository');
  const config = [
    ['user.name', 'ohno'],
    ['user.email', 'ohno@localhost'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
    ['core.quotepath', 'off'],
    ['gc.auto', '0'],
  ];
  for (const [k, v] of config) gitOrDie(root, ['config', k, v]);
  fs.mkdirSync(path.join(sd, 'info'), { recursive: true });
  fs.writeFileSync(path.join(sd, 'info', 'exclude'), '.git/\n');
  fs.writeFileSync(path.join(sd, 'ohno-root'), path.resolve(root) + '\n');
  return sd;
}

export function revParse(root, rev) {
  const r = git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return r.status === 0 ? r.stdout.trim() : null;
}

export function headExists(root) {
  return revParse(root, 'HEAD') !== null;
}

export function subjectOf(root, rev) {
  const r = git(root, ['log', '-1', '--pretty=%s', rev]);
  return r.status === 0 ? r.stdout.trim() : '';
}
