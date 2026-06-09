import fs from 'node:fs';
import path from 'node:path';
import {
  CliError,
  dataDir,
  ensureShadow,
  git,
  gitOrDie,
  headExists,
  revParse,
  shadowDir,
  shadowExists,
  subjectOf,
} from './shadow.js';
import { ago, bold, clock, cyan, dim, green, magenta, red, yellow } from './format.js';

const BACKUP_UNDO = 'backup before undo';

// ---------------------------------------------------------------- snapshots

export function snap(root, { message = 'snapshot' } = {}) {
  ensureShadow(root);
  gitOrDie(root, ['add', '-A'], 'could not scan the working tree');
  if (headExists(root)) {
    const d = git(root, ['diff', '--cached', '--quiet']);
    if (d.status === 0) return null; // nothing changed since last snapshot
    if (d.status !== 1) throw new CliError(`could not compare with last snapshot\n${(d.stderr || '').trim()}`);
  } else if (!git(root, ['ls-files']).stdout.trim()) {
    return null; // nothing to snapshot in an empty project
  }
  gitOrDie(root, ['commit', '-q', '--no-verify', '-m', message], 'could not record the snapshot');
  return { hash: revParse(root, 'HEAD').slice(0, 7) };
}

export function snapCmd(root, { message, quiet }) {
  const result = snap(root, { message: message || 'snapshot' });
  if (quiet) return;
  if (!result) {
    console.log(dim('Nothing new to snapshot — working tree matches the last snapshot.'));
    return;
  }
  console.log(`${green('✓')} Snapshot ${bold(result.hash)} ${dim(lastSnapStat(root))}`);
}

function lastSnapStat(root) {
  const r = git(root, ['show', '--shortstat', '--format=', 'HEAD']);
  return r.status === 0 ? r.stdout.trim().replace(/\s+/g, ' ') : '';
}

// ----------------------------------------------------------------- timeline

const SEP = '\x01';
const FIELD = '\x02';

export function entries(root, n) {
  const args = ['log', `--pretty=format:${SEP}%h${FIELD}%H${FIELD}%ct${FIELD}%s`, '--shortstat'];
  if (n) args.push('-n', String(n));
  const r = git(root, args);
  if (r.status !== 0) return [];
  return r.stdout
    .split(SEP)
    .slice(1)
    .map((chunk) => {
      const [head, ...rest] = chunk.split('\n');
      const [short, hash, ct, subject] = head.split(FIELD);
      const statLine = rest.join(' ');
      const m = statLine.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
      return {
        short,
        hash,
        time: Number(ct),
        subject,
        files: m ? Number(m[1]) : 0,
        add: m && m[2] ? Number(m[2]) : 0,
        del: m && m[3] ? Number(m[3]) : 0,
      };
    });
}

function subjectColor(subject) {
  if (subject.startsWith('claude:') || subject.startsWith('agent:')) return magenta(subject);
  if (subject.startsWith('restore ')) return cyan(subject);
  if (subject === BACKUP_UNDO || subject === 'backup before restore') return dim(subject);
  return subject;
}

export function logCmd(root, { n = 20 }) {
  requireSnapshots(root);
  const list = entries(root, n);
  for (const e of list) {
    const stat =
      e.files === 0 ? dim('—') : `${green(`+${e.add}`)} ${red(`-${e.del}`)} ${dim(`(${e.files} file${e.files === 1 ? '' : 's'})`)}`;
    console.log(`${yellow(e.short)}  ${dim(ago(e.time).padEnd(11))} ${subjectColor(subject(e))}  ${stat}`);
  }
  console.log(dim(`\nohno diff <id> to inspect · ohno undo <id> to time travel`));
}

function subject(e) {
  return e.subject.length > 60 ? e.subject.slice(0, 57) + '…' : e.subject;
}

function requireSnapshots(root) {
  if (!shadowExists(root) || !headExists(root)) {
    throw new CliError('No snapshots yet.\nRun `ohno snap` to take one, or `ohno watch` to take them automatically.');
  }
}

// --------------------------------------------------------------------- undo

export function undo(root, idArg, { quiet = false } = {}) {
  requireSnapshots(root);
  const target = revParse(root, idArg || 'HEAD');
  if (!target) {
    throw new CliError(`Unknown snapshot: ${idArg}\nRun \`ohno log\` to see what exists.`);
  }
  const backup = snap(root, { message: BACKUP_UNDO });
  if (!idArg && !backup) {
    console.log(`${green('✓')} Working tree already matches the latest snapshot.`);
    console.log(dim('To go further back: ohno log, then ohno undo <id>'));
    return;
  }

  // Make index + working tree match the target snapshot exactly.
  gitOrDie(root, ['read-tree', target], 'could not read the snapshot');
  gitOrDie(root, ['checkout-index', '-q', '-f', '-a'], 'could not write files from the snapshot');

  // Files that exist now but not in the target snapshot must be removed.
  const extra = git(root, ['diff', '--name-only', '--diff-filter=A', '-z', target, 'HEAD']);
  for (const name of extra.stdout.split('\0').filter(Boolean)) {
    const p = path.join(root, name);
    fs.rmSync(p, { force: true });
    pruneEmptyDirs(path.dirname(p), root);
  }

  const restored = snap(root, { message: `restore ${target.slice(0, 7)}` });
  if (quiet) return;
  if (!restored && !backup) {
    console.log(`${green('✓')} Working tree already matches ${bold(target.slice(0, 7))}.`);
    return;
  }
  console.log(`${green('✓')} Restored to ${bold(target.slice(0, 7))} ${dim(`· ${subjectOf(root, target)}`)}`);
  if (backup) {
    console.log(dim(`  Changed your mind? Your previous state is snapshot ${backup.hash} — \`ohno redo\` brings it back.`));
  }
}

export function redo(root) {
  requireSnapshots(root);
  const backup = entries(root, 50).find((e) => e.subject === BACKUP_UNDO);
  if (!backup) {
    throw new CliError('Nothing to redo — no recent undo found.');
  }
  undo(root, backup.hash);
}

function pruneEmptyDirs(dir, root) {
  const stop = path.resolve(root);
  let current = path.resolve(dir);
  while (current.startsWith(stop) && current !== stop) {
    try {
      fs.rmdirSync(current); // only succeeds when empty
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

// ------------------------------------------------------------ restore files

export function restoreFiles(root, idArg, files) {
  requireSnapshots(root);
  if (!idArg || files.length === 0) {
    throw new CliError('Usage: ohno restore <id> <file...>');
  }
  const target = revParse(root, idArg);
  if (!target) throw new CliError(`Unknown snapshot: ${idArg}`);

  const rels = files.map((f) => {
    const abs = path.resolve(process.cwd(), f);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..')) throw new CliError(`${f} is outside the project (${root})`);
    return rel.split(path.sep).join('/');
  });

  snap(root, { message: 'backup before restore' });
  const r = git(root, ['checkout', target, '--', ...rels]);
  if (r.status !== 0) {
    throw new CliError(`could not restore from ${idArg}\n${(r.stderr || '').trim()}`);
  }
  snap(root, { message: `restore ${rels.join(', ')} from ${target.slice(0, 7)}` });
  console.log(`${green('✓')} Restored ${bold(rels.join(', '))} from ${bold(target.slice(0, 7))}`);
}

// --------------------------------------------------------------------- diff

export function diffCmd(root, idArg, files) {
  requireSnapshots(root);
  gitOrDie(root, ['add', '-A'], 'could not scan the working tree');
  const args = ['diff', idArg || 'HEAD'];
  if (files.length) args.push('--', ...files);
  const r = git(root, args, { stdio: 'inherit', encoding: undefined });
  process.exitCode = r.status === 1 ? 0 : r.status ?? 0;
}

// ------------------------------------------------------------------- status

export function statusCmd(root) {
  if (!shadowExists(root) || !headExists(root)) {
    console.log(`${bold('ohno')} is not protecting this project yet.\n`);
    console.log(`  ${cyan('ohno snap')}            take a snapshot right now`);
    console.log(`  ${cyan('ohno watch')}           snapshot automatically on every change`);
    console.log(`  ${cyan('ohno install claude')}  snapshot before every Claude Code edit`);
    return;
  }
  gitOrDie(root, ['add', '-A'], 'could not scan the working tree');
  const last = entries(root, 1)[0];
  const stat = git(root, ['diff', '--stat', 'HEAD']).stdout.trimEnd();
  if (!stat) {
    console.log(`${green('✓')} Clean — working tree matches the last snapshot ${dim(`(${ago(last.time)})`)}`);
  } else {
    console.log(`${yellow('●')} Changed since the last snapshot ${dim(`(${ago(last.time)})`)}:\n`);
    const lines = stat.split('\n');
    const shown = lines.length > 16 ? [...lines.slice(0, 15), dim(`  … and ${lines.length - 16} more files`), lines.at(-1)] : lines;
    console.log(shown.join('\n'));
    console.log(dim(`\nohno diff to inspect · ohno snap to keep · ohno undo to discard`));
  }
  console.log(`\n${bold('Recent snapshots')}`);
  for (const e of entries(root, 5)) {
    console.log(`  ${yellow(e.short)}  ${dim(ago(e.time).padEnd(11))} ${subjectColor(subject(e))}`);
  }
}

// -------------------------------------------------------------------- watch

export function watchCmd(root) {
  ensureShadow(root);
  const first = snap(root, { message: 'watch' });
  console.log(`${bold('ohno')} is watching ${cyan(root)}`);
  if (first) console.log(`${green('✓')} ${clock()}  ${bold(first.hash)}  ${dim('initial snapshot')}`);
  console.log(dim('Snapshots on every change · Ctrl-C to stop\n'));

  const DEBOUNCE = 1000;
  const MAX_WAIT = 10_000;
  let timer = null;
  let deadline = null;

  const fire = () => {
    clearTimeout(timer);
    clearTimeout(deadline);
    timer = deadline = null;
    let s;
    try {
      s = snap(root, { message: 'watch' });
    } catch (err) {
      console.error(red(String(err.message || err)));
      return;
    }
    if (s) console.log(`${green('✓')} ${clock()}  ${bold(s.hash)}  ${dim(lastSnapStat(root))}`);
  };

  const watcher = fs.watch(root, { recursive: true }, (_event, fname) => {
    if (fname && String(fname).split(/[\\/]/).includes('.git')) return;
    if (!deadline) deadline = setTimeout(fire, MAX_WAIT);
    clearTimeout(timer);
    timer = setTimeout(fire, DEBOUNCE);
  });

  process.on('SIGINT', () => {
    watcher.close();
    try {
      const s = snap(root, { message: 'watch stop' });
      if (s) console.log(`\n${green('✓')} ${clock()}  ${bold(s.hash)}  ${dim('final snapshot')}`);
    } catch {
      // best effort on shutdown
    }
    console.log(dim('ohno stopped. Your snapshots are safe.'));
    process.exit(0);
  });
}

// ------------------------------------------------------------- integrations

const CLAUDE_HOOK = {
  matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash',
  hooks: [{ type: 'command', command: 'ohno snap -q -m "claude: pre-edit"' }],
};

export function installCmd(root, what) {
  if (what !== 'claude') {
    throw new CliError(
      'Usage: ohno install claude\n\n' +
        'For other agents (Cursor, Codex, Copilot, aider, …) run `ohno watch`\n' +
        'in a second terminal — it protects you from anything that edits files.'
    );
  }
  const file = path.join(root, '.claude', 'settings.json');
  let settings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new CliError(`${file} is not valid JSON — fix it and re-run.`);
    }
  }
  settings.hooks ??= {};
  settings.hooks.PreToolUse ??= [];
  if (JSON.stringify(settings.hooks.PreToolUse).includes('ohno snap')) {
    console.log(`${green('✓')} Already installed — Claude Code snapshots before every file edit.`);
    return;
  }
  settings.hooks.PreToolUse.push(CLAUDE_HOOK);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  console.log(`${green('✓')} Installed a Claude Code hook in ${cyan(path.relative(root, file) || file)}`);
  console.log(dim('  Every file edit by Claude is now preceded by a snapshot (deduped — no-ops are skipped).'));
  console.log(dim('  Note: the hook runs `ohno`, so it must be on PATH (npm i -g ohno-cli).'));
}

// ------------------------------------------------------------- housekeeping

export function pathCmd(root) {
  console.log(shadowDir(root));
}

export function listCmd() {
  const reposDir = path.join(dataDir(), 'repos');
  if (!fs.existsSync(reposDir)) {
    console.log(dim('ohno is not protecting any projects yet.'));
    return;
  }
  const rows = [];
  for (const entry of fs.readdirSync(reposDir)) {
    const sd = path.join(reposDir, entry);
    const rootFile = path.join(sd, 'ohno-root');
    if (!fs.existsSync(rootFile)) continue;
    const root = fs.readFileSync(rootFile, 'utf8').trim();
    const count = git(root, ['rev-list', '--count', 'HEAD']);
    const last = entries(root, 1)[0];
    rows.push({
      root,
      count: count.status === 0 ? count.stdout.trim() : '?',
      when: last ? ago(last.time) : '—',
      stale: !fs.existsSync(root),
    });
  }
  if (!rows.length) {
    console.log(dim('ohno is not protecting any projects yet.'));
    return;
  }
  for (const r of rows) {
    const note = r.stale ? red(' (directory gone — ohno reset --force to clean up)') : '';
    console.log(`${cyan(r.root)}${note}\n  ${r.count} snapshots · last ${r.when}`);
  }
}

export function resetCmd(root, { force }) {
  const sd = shadowDir(root);
  if (!fs.existsSync(sd)) {
    console.log(dim('Nothing to reset — no snapshots for this project.'));
    return;
  }
  if (!force) {
    throw new CliError(
      `This permanently deletes every snapshot for ${root}.\nRe-run with --force if you mean it:  ohno reset --force`
    );
  }
  fs.rmSync(sd, { recursive: true, force: true });
  console.log(`${green('✓')} Deleted all snapshots for ${cyan(root)} ${dim(`(${sd})`)}`);
}
