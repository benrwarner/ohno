# Contributing to ohno

Thanks for helping make uncommitted work unloseable.

## Ground rules

- **Zero runtime dependencies.** This is a feature, not an accident. PRs that add a dependency need an exceptional reason.
- **Plain JavaScript, no build step.** What's in `src/` is what runs.
- **Your real repo is sacred.** Any change touching `src/shadow.js` must preserve the invariant that ohno never reads or writes the user's `.git`. The test `never touches the real git repository` guards this — extend it if you add surface area.
- **History only grows forward.** No command may rewrite or garbage-collect shadow history out from under the user.

## Developing

```sh
git clone https://github.com/benrwarner/ohno && cd ohno
npm test                  # node's built-in test runner, no deps
node bin/ohno.js help     # run your working copy
```

Tests are end-to-end: they spawn the real CLI against temp directories with `OHNO_DIR` isolated. Add one for any behavior change — they run in about two seconds.

## Good first issues

Check the [roadmap in the README](README.md#roadmap) and the issue tracker. `ohno prune` and additional agent integrations are well-scoped starting points.

## Releases

Maintainers: bump `version` in `package.json`, tag `vX.Y.Z`, `npm publish`.
