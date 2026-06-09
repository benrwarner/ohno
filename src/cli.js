import { createRequire } from 'node:module';
import { CliError, projectRoot } from './shadow.js';
import { bold, cyan, dim, red } from './format.js';
import {
  diffCmd,
  installCmd,
  listCmd,
  logCmd,
  pathCmd,
  redo,
  resetCmd,
  restoreFiles,
  snapCmd,
  statusCmd,
  undo,
  watchCmd,
} from './commands.js';

const HELP = `${bold('ohno')} — a flight recorder for your codebase

${bold('Usage')}
  ohno                        what changed since the last snapshot?
  ohno snap [-m <msg>]        take a snapshot now
  ohno watch                  snapshot automatically on every file change
  ohno log [-n <count>]       the timeline of snapshots
  ohno diff [<id>] [file...]  compare the working tree with a snapshot
  ohno undo [<id>]            restore the working tree to a snapshot
  ohno redo                   bring back what the last undo threw away
  ohno restore <id> <file...> restore specific files from a snapshot
  ohno install claude         snapshot before every Claude Code file edit
  ohno list                   every project ohno is protecting
  ohno path                   where this project's snapshots live
  ohno reset --force          delete all snapshots for this project

${bold('Options')}
  -m, --message <msg>   label for the snapshot
  -n <count>            number of timeline entries (default 20)
  -q, --quiet           print nothing on success
  --force               confirm destructive operations
  -v, --version         print the version
  -h, --help            this screen

ohno never touches your real git repository. Snapshots live in a shadow
repo under ${cyan('~/.local/share/ohno')} (override with ${cyan('OHNO_DIR')}).`;

function parse(argv) {
  const flags = { message: undefined, quiet: false, n: undefined, force: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-m' || a === '--message') flags.message = argv[++i];
    else if (a === '-q' || a === '--quiet') flags.quiet = true;
    else if (a === '-n') flags.n = Number(argv[++i]);
    else if (a === '--force') flags.force = true;
    else if (a === '-h' || a === '--help') positional.unshift('help');
    else if (a === '-v' || a === '--version') positional.unshift('version');
    else positional.push(a);
  }
  return { flags, positional };
}

export function main(argv) {
  const { flags, positional } = parse(argv);
  const [cmd, ...rest] = positional;
  try {
    switch (cmd) {
      case undefined:
        return statusCmd(projectRoot());
      case 'snap':
        return snapCmd(projectRoot(), flags);
      case 'log':
        return logCmd(projectRoot(), { n: flags.n || 20 });
      case 'diff':
        return diffCmd(projectRoot(), rest[0], rest.slice(1));
      case 'undo':
        return undo(projectRoot(), rest[0]);
      case 'redo':
        return redo(projectRoot());
      case 'restore':
        return restoreFiles(projectRoot(), rest[0], rest.slice(1));
      case 'watch':
        return watchCmd(projectRoot());
      case 'install':
        return installCmd(projectRoot(), rest[0]);
      case 'list':
        return listCmd();
      case 'path':
        return pathCmd(projectRoot());
      case 'reset':
        return resetCmd(projectRoot(), flags);
      case 'version': {
        const require = createRequire(import.meta.url);
        return console.log(require('../package.json').version);
      }
      case 'help':
        return console.log(HELP);
      default:
        console.error(`${red('unknown command:')} ${cmd}\n`);
        console.log(HELP);
        process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof CliError) {
      console.error(red(err.message));
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}
