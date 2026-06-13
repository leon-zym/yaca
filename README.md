# yaca

yaca is a local, browser-based coding-agent workbench. One Node Host owns runtime state and
serves the Web application from the same loopback origin. Persistent yaca data belongs under
`~/.yaca/`.

This repository currently ships the engineering foundation only: a typed contracts package, a
loopback-only Host, a real health and foundation-bootstrap surface, a production Web shell, and
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
- `--data-dir <path>` injects a runtime root for development or tests.
- `--web-root <path>` serves an alternate built Web directory.
- `--host <host>` exists for explicit configuration but accepts only `127.0.0.1`.

`YACA_HOME` may set the runtime root through the process environment. yaca does not load `.env`
files automatically. Provider keys must remain in the process environment and must not be added
to `.env` or committed files.

## Development

Build the Web shell once and start the TypeScript Host:

```sh
pnpm dev
```

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
pnpm build
pnpm check
```

Tests use temporary filesystems and real loopback HTTP. They cover runtime-root injection,
non-loopback rejection, health/bootstrap schemas, CLI help/version/start parameters, and Web
static fallback.

## Security boundary

yaca is local single-user software, not a public-network service. The Host rejects non-loopback
bind addresses. This is not a filesystem or command sandbox; later agent tools will run with the
user's OS permissions.

## License

[MIT](LICENSE)
