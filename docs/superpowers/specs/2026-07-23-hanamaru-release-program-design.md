# Hanamaru Six-Feature Release Program

**Date:** 2026-07-23  
**Status:** User-approved design; pending independent spec review  
**Repository:** `Ray0907/hanamaru`  
**Package:** `hanamaru-annotations@0.1.0`

## Objective

Turn the completed local Hanamaru runtime into a public, typed, modular OSS release without weakening its small-core, zero-production-dependency, geometry-correct contract. The program adds Selection, serialization, Group, custom SVG marks, scoped Shadow DOM support, React/Vue/Svelte lifecycle adapters, and a Direct Canvas Annotation Inspector. The work finishes with a public GitHub repository, a public npm package, and a GitHub `v0.1.0` release.

This document owns cross-cutting constraints and release sequencing. The bounded feature specs in this directory own their individual APIs and tests:

- `2026-07-23-hanamaru-selection-design.md`
- `2026-07-23-hanamaru-serialization-design.md`
- `2026-07-23-hanamaru-group-design.md`
- `2026-07-23-hanamaru-plugins-design.md`
- `2026-07-23-hanamaru-shadow-design.md`
- `2026-07-23-hanamaru-framework-adapters-design.md`
- `2026-07-23-hanamaru-inspector-design.md`

The earlier `2026-07-22-hanamaru-runtime-design.md` remains authoritative for existing runtime behavior. This program intentionally supersedes its exclusions for framework adapters, Shadow DOM, package publication, and production deployment. It does not change the existing exclusions for accounts, collaboration, AI, image/canvas annotation, freehand drawing, or arbitrary drag positioning.

## Architecture

Hanamaru remains one npm package with optional ESM subpaths:

```text
hanamaru-annotations
├── .                 existing eight-export core
├── ./style.css
├── ./selection
├── ./serialize
├── ./group
├── ./plugins
├── ./shadow
├── ./react
├── ./vue
└── ./svelte
```

The main entry retains exactly `VERSION`, `annotate`, `story`, `scan`, and the four typed error classes. Optional features do not become implicit globals or automatic startup work. The existing IIFE remains core-only. Optional features ship as ESM subpaths with declarations.

Shared source modules may expose package-private hooks to sibling entry points, but those hooks must not appear in the package `exports` map or declaration surface. A subpath must never import another built bundle in a way that creates a second runtime registry. Build entry points share source, and esbuild must externalize framework peers.

## Distribution

The build writes:

```text
dist/
  hanamaru.esm.js
  hanamaru.iife.js
  hanamaru.css
  index.d.ts
  selection/index.js
  selection/index.d.ts
  serialize/index.js
  serialize/index.d.ts
  group/index.js
  group/index.d.ts
  plugins/index.js
  plugins/index.d.ts
  shadow/index.js
  shadow/index.d.ts
  react/index.js
  react/index.d.ts
  vue/index.js
  vue/index.d.ts
  svelte/index.js
  svelte/index.d.ts
```

`package.json` must include `repository`, `homepage`, `bugs`, `keywords`, `types`, explicit conditional `exports`, and `sideEffects`. CSS is the only unconditional side effect and remains opt-in through `./style.css`. The package `files` list remains an allowlist. Published tarballs contain only `dist`, `README.md`, and `LICENSE`.

React, Vue, and Svelte are optional peer dependencies:

- React: `>=18.2.0 <20`, verified against `19.2.8`;
- Vue: `>=3.5.0 <4`, verified against `3.5.40`;
- Svelte: `>=5.0.0 <6`, verified against `5.56.7`.

They are development dependencies only for adapter verification. Runtime production dependencies remain absent.

## Size Budgets

The existing complete core distributions retain their hard cap:

- ESM JavaScript plus base CSS: at most 20,480 bytes at gzip level 9;
- IIFE JavaScript plus base CSS: at most 20,480 bytes at gzip level 9.

Optional entry points are measured with their peer and core imports externalized:

| Subpath | Hard gzip cap |
| --- | ---: |
| `selection` | 3,072 bytes |
| `serialize` | 8,192 bytes |
| `group` | 8,192 bytes |
| `plugins` | 6,144 bytes |
| `shadow` JavaScript plus shadow stylesheet payload | 12,288 bytes |
| each framework adapter | 4,096 bytes |

Every hard cap is enforced by `npm run check:dist`. Size reports must distinguish bundled bytes from external imports and may add report-only stretch targets without weakening hard checks.

## TypeScript Contract

Declarations are authored from a dedicated `types/` source or generated from checked declaration source; JavaScript runtime files are not migrated merely to obtain types. `tsc --noEmit` fixtures must prove:

- every documented import compiles;
- invalid option enums and controller assignments fail with `@ts-expect-error`;
- controller states are string-literal unions;
- custom mark names can be augmented through the plugin type contract;
- adapters infer host refs and controller types;
- every package export resolves its matching declaration.

The build fails if a JavaScript export and declaration export diverge.

## Verification

The stable functional command remains `npm run verify`. It must run, in this order:

1. non-empty unit tests;
2. declaration and type fixtures;
3. production build;
4. dependency, export, tarball-shape, and size checks;
5. Chromium full browser suite;
6. Firefox and WebKit core smoke suites;
7. adapter lifecycle suites.

`npm pack --dry-run --json` is a separate authoritative packaging check. A zero-test stage is failure.

Because Inspector acceptance includes visual layout and motion, Computer Use is authoritative after automated checks. Required real-Chrome states are desktop Idle, Selected, Editing, and Applied; 390 CSS-pixel mobile dock and sheet; keyboard-only operation; reduced motion; note/toolbar bounds; and zero page overflow. Screenshots and accessibility-tree excerpts are saved as release evidence.

## CI and Release

`.github/workflows/ci.yml` runs the fixed verification on pushes and pull requests. `.github/workflows/release.yml` validates a pushed semver tag and prepares release artifacts, but it must not contain a repository token or npm credential. Future trusted publishing can be configured outside this source change.

The first public release is executed in this order:

1. local Verify, pack inspection, and Computer Use verdict are `Correct`;
2. create public `Ray0907/hanamaru`;
3. push the verified branch as `main`;
4. observe the GitHub CI run complete successfully;
5. user completes npm authentication and any 2FA handoff;
6. publish `hanamaru-annotations@0.1.0` with public access;
7. create and push annotated tag `v0.1.0`;
8. create the GitHub Release from that tag with installation, features, size, and verification notes;
9. install the registry version into a fresh temporary project and run a core plus one-subpath smoke test.

No tag or npm publish occurs before the exact commit has passed every local acceptance check. npm versions are immutable release records; a failed later GitHub step is repaired forward and never hidden by rewriting the published version.

## Program Stop Condition

The program is complete only when all bounded specs are implemented, the worktree is clean, local and CI verification pass, registry smoke succeeds, `Ray0907/hanamaru` is public, `hanamaru-annotations@0.1.0` is public, and the GitHub `v0.1.0` release points at the verified commit.
