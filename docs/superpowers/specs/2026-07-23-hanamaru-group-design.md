# Hanamaru Group API Design

**Date:** 2026-07-23  
**Status:** User-approved design; pending independent spec review

## Objective

Control several annotations as one parallel, atomic unit. Group complements ordered Story; it does not accept or emulate Stories.

## Public API

```js
import { group } from 'hanamaru-annotations/group'

const corrections = group([
  { target: '#claim', mark: 'underline' },
  { target: '#result', mark: 'circle', note: 'Check this' },
], {
  trigger: 'manual',
  motion: 'system',
}, {
  root: document,
})

corrections.show()
await corrections.finished
```

The complete signature is:

```ts
function group(
  members: readonly GroupMemberDefinition[],
  options?: GroupOptions,
  context?: { root?: Document | ShadowRoot },
): GroupController
```

Group members are definition objects with `target` plus annotation options except `trigger` and `motion`, which Group owns. Group options are `trigger: manual | load | viewport` and `motion: system | never`. `context.root` defaults to the current document and is an execution environment, not serialized configuration. A viewport Group uses the first member as its trigger target, starts once, and remains visible after exit, matching a viewport annotation.

Group accepts neither existing controllers, Stories, nor nested Groups. It owns every annotation it creates.

## Construction and State

Construction validates every member, resolves every initial target, and creates no visible or partial output on failure. Empty groups are invalid. Every resolved member must have the same resource root and that root must equal `context.root`; mixed documents, Document-plus-ShadowRoot groups, and two different ShadowRoots throw `HanamaruTargetError` before acquiring a lease.

States are `idle`, `showing`, `visible`, `hidden`, `suspended`, and `destroyed`. The controller exposes:

- `state`;
- per-run `finished`;
- read-only `size`;
- `show()`;
- `hide()`;
- `replay()`;
- `refresh()`;
- `destroy()`.

Methods return the Group controller. `show()` and `replay()` start every member in input order in the same task; scheduler batching preserves read-all/write-all behavior. `finished` resolves after every member is visible.

Before the first accepted run, `finished` is `null`. Accepted `show()` and `replay()` calls create a new per-run Promise. Superseding a pending run, `hide()`, or `destroy()` rejects that Promise with `AbortError`.

The transition contract is:

| Method | Accepted states | Result | No-op states |
| --- | --- | --- | --- |
| `show()` | `idle`, `hidden`, `suspended` | preflight, then `showing`; settles `visible` or `suspended` | `showing`, `visible`, `destroyed` |
| `hide()` | `showing`, `visible`, `suspended` | abort pending run, hide all, settle `hidden` | `idle`, `hidden`, `destroyed` |
| `replay()` | every state except `destroyed` | preflight all; on success supersede, clear, and start a fresh run | `destroyed` |
| `refresh()` | `showing`, `visible`, `suspended` | re-resolve and redraw all without a new Promise; a requested-visible suspended Group may recover to `visible` | `idle`, `hidden`, `destroyed` |
| `destroy()` | every state except `destroyed` | abort, reverse teardown, settle `destroyed` | `destroyed` |

`replay()` preflights every member before invalidating a current run or clearing output. A preflight failure dispatches `hana:error` and leaves state, output, and `finished` identity unchanged. A suspended `show()` preflights again and may recover with a fresh run.

Load-trigger listeners are removed when accepted or destroyed. The viewport observer is root-scoped, disconnects after its first accepted entry, and is released on destroy or trigger failure. Automatic-trigger cleanup follows the same contained, idempotent teardown rules as Annotation and Story.

## Atomic Runtime Failure

If any member fails during a Group run:

1. the run generation is invalidated;
2. all members started by that run are hidden;
3. remaining pending member promises are observed and cancelled without unhandled rejection;
4. Group enters `suspended`;
5. `finished` rejects with `HanamaruStateError` code `HANA_STATE_GROUP_MEMBER`, whose details include `index` and the typed member error.

`refresh()` attempts every member and reports the lowest-index failure after containing all member errors. `destroy()` tears members down in reverse order and reaches `destroyed` even when cleanup throws; the first normalized teardown error is reported through `hana:error`.

## Events

Group dispatches existing `hana:start`, `hana:complete`, `hana:cancel`, and `hana:error` events from the first member owner. Detail includes `{ controller, state }` and adds `index` only for member failure. Group does not dispatch `hana:step`; parallel members have no logical step order.

## Verification

Unit and browser tests cover the complete transition table, preflight atomicity, parallel start, scheduler ordering, `finished` identity and aborts, suspended recovery, replay-preflight preservation, automatic-trigger teardown, viewport trigger, reduced motion, a failure at every member index, synchronous reentrant listeners, target replacement before replay, cleanup errors, no unhandled rejections, serialization metadata, and the absence of nested ownership. Root tests cover one Document, one ShadowRoot through `context.root`, and every mixed-root rejection. Type tests enforce member, option, and context boundaries.
