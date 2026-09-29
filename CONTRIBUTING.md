# Contributing to Petty

## Setup

Install [Nix with flakes enabled](https://nixos.org/download), then:

```bash
git clone https://github.com/phongndo/petty.git
cd petty
nix develop
pnpm install --frozen-lockfile
pnpm dev
```

For one-off commands use `nix develop -c <command>`. pnpm's version is pinned by `packageManager` in [package.json](package.json); the Nix shell installs that native pnpm release (update the hashes in [flake.nix](flake.nix) when bumping it), supplies Node 24, and pins Zig. TypeScript scripts, tests and benchmarks run on Node through `tsx`. The root `postinstall` handles Electron installation and NixOS ELF repair.

## Changing code

- Follow the boundary in [docs/architecture.md](docs/architecture.md): `pettyd` owns durable PTYs and the mux graph; Electron main owns the bridge, and the renderer presents terminals. Keep terminal bytes off the React state path.
- For output transport and recovery changes, read [docs/terminal-byte-path.md](docs/terminal-byte-path.md) and run `pnpm test:persistence`; for daemon changes run `pnpm zig:test`.
- `pnpm check` runs the curated lint, format, TypeScript, Node tests, and Zig tests. `pnpm build` checks the production bundle. For performance-sensitive changes use the relevant benchmark script in [package.json](package.json); distinguish headless smoke results from hardware-renderer measurements.
- Zig ownership changes: use `std.testing.allocator` in tests, pair acquired resources with cleanup on partial failure, and exercise teardown. `pnpm zig:leak-check` runs the daemon with a debug allocator under a temporary `HOME` rather than touching `~/.petty`.

TypeScript uses oxlint and oxfmt; Zig uses `zig fmt` and `zig ast-check`. `pnpm fmt` formats TypeScript and Zig. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## Documentation

Keep current behavior and non-obvious boundaries in the owning code or technical note; link to scripts and schemas rather than copying inventories or command flags. Replace stale claims when behavior changes. Put dated, reproducible measurements in `docs/benchmarks/` with hardware, commands, samples, and limitations. Use issues or a working session for speculative plans and progress checklists; Git preserves old versions.

Petty is licensed under [MIT](LICENSE).
