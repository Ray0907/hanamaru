# Hanamaru Framework Adapters Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship thin React 18/19, Vue 3.5, and Svelte 5 adapters that safely own one manual Annotation controller.

**Architecture:** A framework-free adapter lifecycle helper handles create/show/update/replace/destroy and asynchronous failures. Each framework file only maps its lifecycle/ref idioms to that helper; all peer packages remain external and optional.

**Tech Stack:** ES2020 JavaScript, React hooks, Vue Composition API, Svelte actions, TypeScript declaration tests, Playwright component fixtures.

**Required skills during execution:** `@superpowers:test-driven-development`, `@codex-loop-engineering`.

**Design authority:** `docs/superpowers/specs/2026-07-23-hanamaru-framework-adapters-design.md`.

**Execution dependencies:** Run this after the runtime feature plans. The endpoint runner installs each peer plus TypeScript into an isolated temporary project and maps `hanamaru-annotations` to the current source/build, so it does not depend on the final package export map. The Release plan later copies declarations and enforces public exports.

---

## File Map

| Path | Responsibility |
|---|---|
| `src/adapters/lifecycle.js` | Shared controller ownership, async error channels, dedup, cleanup. |
| `src/adapters/react.js` | `useAnnotation` hook. |
| `src/adapters/vue.js` | Vue 3.5 `useAnnotation` composable. |
| `src/adapters/svelte.js` | Svelte 5 `annotation` action. |
| `types/react/index.d.ts` | React public declaration in emitted directory shape. |
| `types/vue/index.d.ts` | Vue public declaration in emitted directory shape. |
| `types/svelte/index.d.ts` | Svelte public declaration in emitted directory shape. |
| `tests/unit/adapter-lifecycle.test.js` | Framework-free lifecycle/failure state machine. |
| `tests/framework/*` | Endpoint installs, SSR imports, declarations, real framework fixtures. |
| `tests/framework/types/index.d.ts` | Minimal approved core types for synthetic pre-release packages. |

## Chunk 1: Shared Lifecycle and React

### Task 1: Create the isolated endpoint runner

**Files:**
- Create: `tests/framework/run-endpoints.mjs`
- Create: `tests/framework/package-fixture.json`

- [ ] **Step 1: Implement the exact runner contract**

Accept `react|vue|svelte|all` plus optional versions. For every endpoint, create an isolated temporary directory and install `@playwright/test@1.55.0`, `esbuild@0.25.0`, and TypeScript `5.9.2`. React 18 installs `react@18.2.0`, `react-dom@18.2.0`, `@types/react@18.3.31`, and `@types/react-dom@18.3.7`; React 19 installs `react@19.2.8`, `react-dom@19.2.8`, `@types/react@19.2.17`, and `@types/react-dom@19.2.3`. Vue installs the exact Vue version. Svelte installs the exact Svelte version and uses its compiler for the real component fixture.

Create a synthetic `node_modules/hanamaru-annotations` package rather than using the current export map. Its package JSON includes `"type":"module"` and maps `.` runtime to `./src/index.js`, core types to `./types/index.d.ts`, and the selected adapter to `./src/adapters/<name>.js` plus `./types/<name>/index.d.ts`. Recursively copy the project `src/` into the synthetic package—do not symlink—so Node/esbuild resolve peer imports only from the endpoint installation. Copy `tests/framework/types/index.d.ts` and the selected adapter declaration into the synthetic `types/` tree. Run a real browser fixture through Playwright/esbuild, an SSR fixture in Node, and `tsc --noEmit`; delete the temp directory in `finally`. Exit non-zero on zero selected fixtures.

- [ ] **Step 2: Verify the empty fixture guard**

Run `node tests/framework/run-endpoints.mjs react 18.2.0`.

Expected: FAIL with `framework-endpoints: missing react runtime fixture`; the runner itself resolves and parses.

- [ ] **Step 3: Commit the runnable harness**

```bash
git add tests/framework/run-endpoints.mjs tests/framework/package-fixture.json
git commit -m "test: add isolated framework endpoint runner"
```

### Task 2: Implement the framework-free adapter owner

**Files:**
- Create: `src/adapters/lifecycle.js`
- Create: `tests/unit/adapter-lifecycle.test.js`

- [ ] **Step 1: Write RED tests for mount/update/replace ordering**

Assert exact API `createAdapterOwner({ create, expose, queueThrow })` with `mount(target, options, config)`, `update(target, options, config)`, and `destroy()`. Cover enabled default, listener-before-show, canonical same-target update, create/show-new-before-destroy-old replacement, disable/re-enable, exposure order, exactly-once destroy, synchronous construction failure, same-target controller `update()` failure with cleanup/exposed null, direct rethrow, and replacement rollback when new creation/show fails.

- [ ] **Step 2: Run ordering tests and verify RED**

Run `node --test --test-name-pattern="mount|update|replace|disable|destroy" tests/unit/adapter-lifecycle.test.js`.

Expected: FAIL for missing lifecycle module.

- [ ] **Step 3: Implement generation-owned mount/update/replace**

Normalize adapter-only config separately, reject `trigger`, compare canonical fields rather than object identity, and keep generation/controller/listener cleanup in one record. Expose only after `show()` is accepted. Synchronous construction/update errors contain owned resources, expose null when a controller had been exposed, and rethrow directly from the lifecycle call. On replacement, fully accept new ownership before tearing down old; retain prior ownership only when it was not part of the failing operation.

- [ ] **Step 4: Run ordering tests and verify GREEN**

Run the Step 2 command.

Expected: all mount/update/replace/disable/destroy tests pass.

- [ ] **Step 5: Write RED tests for asynchronous failure channels**

Cover current/stale accepted `finished` rejection, post-visible refresh/observer/update `hana:error`, exact controller filter, Promise/event same-error and same-generation dedup, AbortError suppression, listener removal, cleanup-before-`onError`, no callback path, and throwing `onError` queued rethrow.

- [ ] **Step 6: Run failure tests and verify RED**

Run `node --test --test-name-pattern="finished|hana:error|dedup|AbortError|onError|stale" tests/unit/adapter-lifecycle.test.js`.

Expected: failures are unobserved before the channel implementation.

- [ ] **Step 7: Implement the two-channel failure coordinator**

Attach owner `hana:error` before `show()`, filter `event.detail.controller`, observe the exact accepted `finished`, retain listener after resolve, and store per-generation error identity. Current non-Abort failure destroys the controller, removes listeners, and exposes null once; stale events/Promises do nothing; callback exceptions queue after cleanup.

- [ ] **Step 8: Run all lifecycle tests and commit**

```bash
node --test tests/unit/adapter-lifecycle.test.js
git add src/adapters/lifecycle.js tests/unit/adapter-lifecycle.test.js
git commit -m "feat: own annotation adapter lifecycles"
```

Expected: every sync/async lifecycle test passes.

### Task 3: Add the React hook

**Files:**
- Create: `src/adapters/react.js`
- Create: `types/react/index.d.ts`
- Create: `tests/framework/types/index.d.ts`
- Create: `tests/framework/react.test.mjs`
- Create: `tests/framework/react-ssr.test.mjs`
- Create: `tests/framework/react-types.tsx`

- [ ] **Step 1: Write failing React 18.2.0/19.2.8 fixtures**

Test browser mount/show, canonical update without remount, ref replacement, disable/re-enable, unmount, Strict Mode double effect, runtime `trigger` rejection, synchronous construction/update cleanup and direct rethrow, reduced-motion inheritance, zero duplicate overlays/ARIA tokens, accepted-show `finished` failure, post-visible `hana:error`, stale Promise/event suppression, listener removal after replacement/unmount, onError dedup, throwing-onError cleanup, SSR import/render with no DOM work, and returned readonly controller ref. Compile representative TSX against `tests/framework/types/index.d.ts`.

- [ ] **Step 2: Run both React endpoints and verify RED**

Run `node tests/framework/run-endpoints.mjs react 18.2.0 19.2.8`.

Expected: both endpoints fail to import missing `src/adapters/react.js`.

- [ ] **Step 3: Implement with layout-phase browser ownership**

Use a layout-effect-compatible hook, one owner ref, canonical field dependency comparison, and the shared lifecycle helper. Omit/reject `trigger`.

- [ ] **Step 4: Run endpoint tests and verify GREEN**

Run `node tests/framework/run-endpoints.mjs react 18.2.0 19.2.8`.

Expected: both versions and declaration fixture pass.

- [ ] **Step 5: Commit React**

```bash
git add src/adapters/react.js types/react/index.d.ts tests/framework/types/index.d.ts tests/framework/react.test.mjs tests/framework/react-ssr.test.mjs tests/framework/react-types.tsx
git commit -m "feat: add React annotation hook"
```

## Chunk 2: Vue and Svelte

### Task 4: Add Vue 3.5 composable

**Files:**
- Create: `src/adapters/vue.js`
- Create: `types/vue/index.d.ts`
- Create: `tests/framework/vue.test.mjs`
- Create: `tests/framework/vue-ssr.test.mjs`
- Create: `tests/framework/vue-types.ts`

- [ ] **Step 1: Write failing Vue 3.5.0/3.5.40 tests**

Cover mount/show, `ShallowRef` exposure, finite canonical deep-field watching, enabled/config refs, target replacement, runtime trigger rejection, synchronous construction/update cleanup/exposed-null/direct rethrow, accepted-show and post-visible failure channels, stale suppression/listener removal/throwing-onError cleanup, reduced motion, duplicate output/token absence, unmount, SSR, and declaration compilation.

- [ ] **Step 2: Run endpoints and verify RED**

Run `node tests/framework/run-endpoints.mjs vue 3.5.0 3.5.40`.

Expected: both endpoints fail to import missing `src/adapters/vue.js`.

- [ ] **Step 3: Implement using `onMounted`, finite `watch`, and `onBeforeUnmount`**

Read refs with Vue APIs, never traverse arbitrary user objects, and delegate every controller operation to the shared owner.

- [ ] **Step 4: Run endpoint tests and verify GREEN**

Run `node tests/framework/run-endpoints.mjs vue 3.5.0 3.5.40`.

Expected: both versions pass.

- [ ] **Step 5: Commit Vue**

```bash
git add src/adapters/vue.js types/vue/index.d.ts tests/framework/vue.test.mjs tests/framework/vue-ssr.test.mjs tests/framework/vue-types.ts
git commit -m "feat: add Vue annotation composable"
```

### Task 5: Add Svelte 5 action

**Files:**
- Create: `src/adapters/svelte.js`
- Create: `types/svelte/index.d.ts`
- Create: `tests/framework/svelte.test.mjs`
- Create: `tests/framework/svelte-ssr.test.mjs`
- Create: `tests/framework/svelte-types.ts`

- [ ] **Step 1: Write failing Svelte 5.0.0/5.56.7 tests**

Cover every `onController` transition, same-target update silence, disable/re-enable, replacement, trigger rejection, synchronous construction/update cleanup/null callback/direct action rethrow, accepted-show/post-visible failures and dedup, reduced motion, duplicate output/token absence, stale suppression/listener removal, throwing callbacks, destroy, SSR import, and action typing.

- [ ] **Step 2: Run endpoints and verify RED**

Run `node tests/framework/run-endpoints.mjs svelte 5.0.0 5.56.7`.

Expected: both endpoints fail to import missing `src/adapters/svelte.js`.

- [ ] **Step 3: Implement `annotation(node, input)`**

Return exact `update(nextInput)`/`destroy()` methods and use the shared owner. Call `onController` only at the transitions defined by the spec.

- [ ] **Step 4: Run endpoint tests and verify GREEN**

Run `node tests/framework/run-endpoints.mjs svelte 5.0.0 5.56.7`.

Expected: both versions pass.

- [ ] **Step 5: Commit Svelte**

```bash
git add src/adapters/svelte.js types/svelte/index.d.ts tests/framework/svelte.test.mjs tests/framework/svelte-ssr.test.mjs tests/framework/svelte-types.ts
git commit -m "feat: add Svelte annotation action"
```

### Task 6: Verify adapter isolation

**Files:**
- Create: `tests/unit/adapter-bundles.test.js`

- [ ] **Step 1: Add bundle/peer/SSR verification**

Build each adapter with its framework peer external. Compute the optional closure as the adapter entry plus every transitive local chunk not already charged to the main ESM closure; gzip each member at level 9 and sum it. Assert each closure is ≤4,096 bytes, no peer or duplicate runtime is bundled, and Node imports are DOM-safe.

- [ ] **Step 2: Run all adapter verification**

```bash
node --test tests/unit/adapter-lifecycle.test.js tests/unit/adapter-bundles.test.js
node tests/framework/run-endpoints.mjs all
```

Expected: all six endpoint combinations, SSR fixtures, type fixtures, and size caps pass.

- [ ] **Step 3: Commit isolation verification**

```bash
git add tests/unit/adapter-bundles.test.js
git commit -m "test: enforce framework adapter isolation"
```
