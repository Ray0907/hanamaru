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
})

corrections.show()
await corrections.finished
```

Group members are definition objects with `target` plus annotation options except `trigger` and `motion`, which Group owns. Group options are `trigger: manual | load | viewport` and `motion: system | never`. A viewport Group uses the first member as its trigger target, starts once, and remains visible after exit, matching a viewport annotation.

Group accepts neither existing controllers, Stories, nor nested Groups. It owns every annotation it creates.

## Construction and State

Construction validates every member, resolves every initial target, and creates no visible or partial output on failure. Empty groups are invalid.

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

## Atomic Runtime Failure

If any member fails during a Group run:

1. the run generation is invalidated;
2. all members started by that run are hidden;
3. remaining pending member promises are observed and cancelled without unhandled rejection;
4. Group enters `suspended`;
5. `finished` rejects with `HanamaruStateError` code `HANA_STATE_GROUP_MEMBER`, whose details include `index` and the typed member error.

`refresh()` attempts every member and reports the first failure after containing all member errors. `replay()` preflights every target again before clearing current output. `destroy()` tears members down in reverse order and reaches `destroyed` even when cleanup throws; the first normalized teardown error is reported through `hana:error`.

## Events

Group dispatches existing `hana:start`, `hana:complete`, `hana:cancel`, and `hana:error` events from the first member owner. Detail includes `{ controller, state }` and adds `index` only for member failure. Group does not dispatch `hana:step`; parallel members have no logical step order.

## Verification

Unit and browser tests cover preflight atomicity, parallel start, scheduler ordering, resolve timing, hide/replay/destroy, viewport trigger, reduced motion, a failure at every member index, synchronous reentrant listeners, target replacement before replay, cleanup errors, no unhandled rejections, serialization metadata, and the absence of nested ownership. Type tests enforce member and option exclusions.
