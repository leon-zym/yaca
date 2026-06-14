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

The production CLI always uses `~/.yaca/`. If the root is missing, yaca creates it with owner-only
permissions (`0700`) and canonicalizes it before the Host starts. It refuses a symbolic link at the
data-root leaf and rejects derived paths that escape the canonical root. A stable hash of that root
selects one yaca authority port in the reserved loopback range `49152–50175`. The Host binds that
port exclusively before starting HTTP; the kernel socket is the ownership fence and is released
immediately if the process exits or is killed. `~/.yaca/run/host.lock` is atomic diagnostic JSON
only and never establishes ownership. A hash collision or unrelated local process on the derived
port fails closed with a startup error. Graceful shutdown gives active HTTP connections two seconds
before force-closing them, and releases the authority port last. Tests inject temporary roots only
through the Host package's module API. The foundation does not load `.env` files.

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

Tests use temporary filesystems and real loopback HTTP. They cover canonical runtime-root
preparation, root-leaf and derived-path symlink rejection, owner-only root creation, the kernel
authority fence (including SIGKILL recovery, event-loop blocking, unrelated port ownership, and
concurrent contenders), bounded connection shutdown, non-loopback rejection, the health schema,
production and development CLI startup, and Web static fallback. The pack smoke builds a tarball,
installs it into a fresh temporary consumer, and starts the installed `yaca` binary.

## Security boundary

yaca is local single-user software, not a public-network service. The Host rejects non-loopback
bind addresses. This is not a filesystem or command sandbox; later agent tools will run with the
user's OS permissions.

## License

[MIT](LICENSE)
