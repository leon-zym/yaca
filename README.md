# yaca

yaca is a local, browser-based coding-agent workbench. One Node Host owns runtime state and
serves the Web application from the same loopback origin. Persistent yaca data belongs under
`~/.yaca/`.

This repository currently ships the engineering foundation only: a typed contracts package, a
loopback-only Host, a non-authoritative health surface, a production Web shell, and
the `yaca` CLI. Workspace and Session management, the Pi adapter, model calls, agent streaming,
and file or shell tools are not implemented in this slice. The Web shell says so explicitly and
contains no demo data or placeholder controls.

## Requirements

- Node.js 22.19 or newer
- Corepack

The current Foundation and MVP acceptance target is macOS and Linux. Windows build, typecheck, and
package smoke coverage is best-effort; the root `pnpm dev` process-tree smoke is POSIX-only and has
not been validated on Windows hardware.

The workspace pins pnpm in `package.json`; use Corepack rather than a separately installed pnpm.

## Install and build

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

## Start

From a checkout:

```sh
pnpm yaca
```

The published package entry point is named `yaca`. It listens only on `127.0.0.1` and serves the
built Web application from the same origin. Open the URL printed by the command.

```text
Usage: yaca [start] [options]
```

Useful options:

- `--port <port>` selects the local port; use `0` to ask the OS for an ephemeral port.
- `--host <host>` exists for explicit configuration but accepts only `127.0.0.1`.

The production CLI always uses `~/.yaca/`. On a fresh install, the first `yaca` start creates the
root and its seven runtime directories—`agent`, `app`, `content`, `trash`, `logs`, `run`, and
`tmp`—with exact owner-only permissions (`0700`); no manual directory preparation is required.
An existing root or runtime directory is accepted only when it is a canonical, non-symlink
directory owned by the current user with mode `0700`. yaca never repairs an existing directory's
permissions automatically. If startup reports an unsafe existing directory, inspect its ownership
and, when it is the intended current-user directory, run `chmod 700 ~/.yaca` for the root or, for
example, `chmod 700 ~/.yaca/app` when `app` is the directory named by the error, then start yaca
again. Derived paths that escape the canonical root are rejected.

A stable hash of the canonical root selects two distinct yaca authority ports from independent
SHA-256 segments across the dynamic and private loopback range `49152–65535`. The Host binds both
ports exclusively before starting HTTP;
the pair of kernel sockets is the ownership fence and is released immediately if the process exits
or is killed. If either bind fails, startup releases any socket already acquired and fails closed.
No ownership or diagnostic lock file is written to disk; the non-sensitive derived port pair is
visible through `/api/health`. If two different roots share either derived port, yaca conservatively
refuses the later start; an unrelated local process on either port has the same fail-closed result.
The startup error names the conflicting port. Graceful shutdown gives active HTTP connections two
seconds before force-closing them, then releases both authority ports in reverse acquisition order.
Tests inject temporary roots only through the Host package's module API. The foundation does not
load `.env` files.

`GET /api/health` is liveness status for the local shell. It is not application bootstrap or
authority state. Authentication, origin enforcement, and the application protocol gateway belong
to a later security slice and are not present in this foundation.

## Development

Build the Web shell once and start the TypeScript Host:

```sh
pnpm dev
```

Source development reports the explicit non-release version `0.0.0-dev`; production builds inject
the release version from the root package manifest.

For Web-only iteration, run `pnpm dev:web`; Vite binds to `127.0.0.1:5173` and proxies `/api` to a
Host on `127.0.0.1:3210`.

Repository seams:

```text
apps/host          loopback HTTP/static Host and yaca CLI
apps/web           React, TypeScript, Tailwind CSS, shadcn/ui Web shell
packages/contracts closed TypeBox schemas shared by Host and Web
```

## Verification

```sh
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm test:pack
pnpm build
pnpm check
```

Tests use temporary filesystems and real loopback HTTP. They cover creation and canonicalization of
the root and all seven runtime directories, acceptance of existing current-user `0700`
directories, rejection without repair of unsafe existing root/child modes and a hard-linked root
file, root-leaf and derived-path symlinks, and the kernel authority fence (including SIGKILL
recovery, event-loop blocking, unrelated port ownership, and concurrent contenders). They also
cover bounded connection shutdown, non-loopback rejection, the health schema, production and POSIX
development CLI startup, and Web static fallback. The pack smoke builds a tarball, installs it into
a fresh temporary consumer, and starts the installed `yaca` binary.

## Security boundary

yaca is local single-user software, not a public-network service. The Host rejects non-loopback
bind addresses. This is not a filesystem or command sandbox; later agent tools will run with the
user's OS permissions.

## License

[MIT](LICENSE)
