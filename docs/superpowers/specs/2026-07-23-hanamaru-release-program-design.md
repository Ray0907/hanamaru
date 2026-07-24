# Hanamaru Public Release Program

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

The user's six requested stages map to the bounded specs as follows:

| Requested stage | Bounded specification |
| --- | --- |
| TypeScript plus public release | this program specification |
| Selection API | Selection |
| JSON serialization | Serialization |
| Annotation Inspector | Inspector |
| Group API | Group |
| Plugin API, Shadow DOM, and framework wrappers | Plugins, Shadow, and Framework Adapters |

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

Shared source modules may expose package-private hooks to sibling entry points, but those hooks must not appear in the package `exports` map or declaration surface. A subpath must never import another independently bundled copy of runtime state.

All ESM entries are built in one esbuild graph with `format: 'esm'`, `splitting: true`, and one `outdir`. The graph emits one shared singleton chunk that owns the custom-mark registry, controller-metadata symbol and WeakMaps, and root-resource registries. Every core and optional ESM entry imports that emitted chunk. The core IIFE is a separate core-only graph and has its own browser-global realm by design. A cross-subpath browser test imports core, Plugins, Serialization, Group, and Shadow together and proves registry, metadata, and root-resource identity.

## Distribution

The build writes:

```text
dist/
  hanamaru.esm.js
  hanamaru.iife.js
  hanamaru.css
  index.d.ts
  _chunks/
    *.js
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
  shadow/hanamaru-shadow.css
  react/index.js
  react/index.d.ts
  vue/index.js
  vue/index.d.ts
  svelte/index.js
  svelte/index.d.ts
```

`package.json` must include `repository`, `homepage`, `bugs`, `keywords`, `types`, explicit conditional `exports`, and the exact `sideEffects` array `["./dist/hanamaru.css", "./dist/shadow/hanamaru-shadow.css"]`. CSS remains opt-in through either public CSS export; JavaScript entries have no top-level side effects. The package `files` list remains an allowlist. Published tarballs contain only npm's mandatory `package.json` plus `dist`, `README.md`, and `LICENSE`.

React, Vue, and Svelte are optional peer dependencies:

- React: `>=18.2.0 <20`, verified against `19.2.8`;
- Vue: `>=3.5.0 <4`, verified against `3.5.40`;
- Svelte: `>=5.0.0 <6`, verified against `5.56.7`.

They are development dependencies only for adapter verification. Runtime production dependencies remain absent.

The normative export map shape is:

```json
{
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/hanamaru.esm.js"
  },
  "./style.css": "./dist/hanamaru.css",
  "./selection": {
    "types": "./dist/selection/index.d.ts",
    "import": "./dist/selection/index.js"
  },
  "./serialize": {
    "types": "./dist/serialize/index.d.ts",
    "import": "./dist/serialize/index.js"
  },
  "./group": {
    "types": "./dist/group/index.d.ts",
    "import": "./dist/group/index.js"
  },
  "./plugins": {
    "types": "./dist/plugins/index.d.ts",
    "import": "./dist/plugins/index.js"
  },
  "./shadow": {
    "types": "./dist/shadow/index.d.ts",
    "import": "./dist/shadow/index.js"
  },
  "./shadow/style.css": "./dist/shadow/hanamaru-shadow.css",
  "./react": {
    "types": "./dist/react/index.d.ts",
    "import": "./dist/react/index.js"
  },
  "./vue": {
    "types": "./dist/vue/index.d.ts",
    "import": "./dist/vue/index.js"
  },
  "./svelte": {
    "types": "./dist/svelte/index.d.ts",
    "import": "./dist/svelte/index.js"
  },
  "./package.json": "./package.json"
}
```

`dist/_chunks/*.js` is package-internal, included by the tarball allowlist through `dist`, and intentionally absent from public exports. Tarball and import tests prove every emitted relative chunk import resolves after packing.

## Size Budgets

The complete approved runtime was measured after all feature families, Shadow DOM
support, serialization, plugins, and framework adapters were implemented. Budgets
are closure-specific binary-unit thresholds with modest deterministic headroom;
they are not per-file limits inherited from the earlier, smaller feature set.

| Closure | Hard gzip cap | Stretch target |
| --- | ---: | ---: |
| main ESM JavaScript plus base CSS | 28,672 bytes (28 KiB) | 27,648 bytes (27 KiB) |
| main IIFE JavaScript plus base CSS | 24,576 bytes (24 KiB) | 23,552 bytes (23 KiB) |
| `selection` | 3,072 bytes | 2,560 bytes |
| `serialize` | 11,264 bytes (11 KiB) | 10,752 bytes (10.5 KiB) |
| `group` | 8,192 bytes | 7,680 bytes |
| `plugins` | 6,144 bytes | 5,632 bytes |
| `shadow` JavaScript plus shadow stylesheet payload | 21,504 bytes (21 KiB) | 20,480 bytes (20 KiB) |
| `react` | 4,096 bytes | 3,584 bytes |
| `vue` | 4,096 bytes | 3,584 bytes |
| `svelte` | 4,096 bytes | 3,584 bytes |

Size accounting uses gzip level 9 over file bytes:

- a main ESM closure is the ESM entry plus every transitive local chunk it imports, counted once, plus `hanamaru.css`;
- the IIFE closure is the IIFE plus `hanamaru.css`;
- an optional closure is the optional entry plus every transitive local chunk not already in the main ESM closure;
- a chunk shared by two optional entries is conservatively charged in full to each optional closure;
- bare framework peer imports are external and contribute zero package bytes;
- Shadow's budget is its optional JavaScript closure plus the separately gzipped UTF-8 bytes of `shadow/hanamaru-shadow.css`;
- gzip members are measured independently and their byte counts summed, matching the existing JavaScript-plus-CSS methodology.

Every hard cap is enforced by `npm run check:dist`; stretch targets are
report-only. The report records entry files, charged chunks, raw bytes,
individual gzip bytes, summed closure bytes, and the closure-specific hard and
stretch thresholds so two implementations cannot account for the same artifact
differently.

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

.github/workflows/ci.yml runs the fixed verification on pushes and pull requests with `permissions: { contents: read }`. On `main`, it runs `npm pack --json`, records the tarball SHA-512, and uploads the exact `.tgz` plus digest as a workflow artifact.

`.github/workflows/release.yml` runs on `v*` tags with `permissions: { contents: read }`. It first checks out the tagged commit without persisting credentials, then runs checked-in `scripts/check-release-tag.mjs` before dependency installation. That dependency-free script reads `package.json`, validates both package version and text after `v` with the SemVer 2.0.0 grammar implemented in the script, and requires the original tag to equal `v${package.json.version}` byte-for-byte. A malformed, normalized-but-not-identical, or mismatched tag fails before install or build. The workflow then installs the lockfile, repeats the full verification, creates the exact pack tarball once, records its SHA-512, and uploads both as a workflow artifact. It has no `id-token: write`, `packages: write`, npm token, persisted npm configuration, or release-write permission. Unit tests run the validator against valid, invalid, normalized-but-different, and version-mismatched tags. Future trusted publishing may be configured as a separate reviewed change.

The first public release is executed in this order:

1. local Verify, local pack inspection, and Computer Use verdict are `Correct` on a clean commit;
2. create public `Ray0907/hanamaru`;
3. push that commit as `main`;
4. observe the `main` CI run complete successfully for the exact commit SHA;
5. create and push annotated tag `v0.1.0` pointing to that SHA;
6. observe the tag release workflow complete successfully;
7. download the tag workflow's `.tgz` and SHA-512 artifact and verify its digest locally without rebuilding;
8. user completes npm authentication and any 2FA handoff;
9. publish that exact downloaded tarball with `npm publish <artifact.tgz> --access public`;
10. create the GitHub Release from `v0.1.0`, attach the same tarball and digest, and include installation, features, size, and verification notes;
11. install the registry version into a fresh temporary project and run a core plus one-subpath smoke test.

No tag or npm publish occurs before the exact commit has passed every local acceptance check. The release artifact is built once by the tag workflow and identified by commit, filename, npm pack metadata, and SHA-512. A dirty worktree, mismatched HEAD, mismatched digest, failed workflow, or rebuilt tarball stops publication. npm authentication remains in the user's local npm client and is never written to the repository or workflow. npm versions are immutable release records; a failed later GitHub step is repaired forward and never hidden by rewriting the published version.

## Program Stop Condition

The program is complete only when all bounded specs are implemented, the worktree is clean, local and CI verification pass, registry smoke succeeds, `Ray0907/hanamaru` is public, `hanamaru-annotations@0.1.0` is public, and the GitHub `v0.1.0` release points at the verified commit.
