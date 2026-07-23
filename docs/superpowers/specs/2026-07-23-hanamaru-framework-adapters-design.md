# Hanamaru Framework Adapter Design

**Date:** 2026-07-23  
**Status:** User-approved design; pending independent spec review

## Objective

Provide thin lifecycle adapters for React, Vue 3.5, and Svelte 5. Adapters create, atomically update, expose, and destroy the same framework-free Annotation controller; they do not reimplement rendering or add framework code to the core bundle.

## Shared Rules

- Server rendering imports are safe and perform no DOM work.
- Controllers are created only after the host element is mounted in a browser.
- Adapter annotation options omit `trigger`; adapters always create a manual annotation.
- `enabled` defaults to `true`. An enabled mounted adapter creates and immediately calls `show()`, so every documented example becomes visible without another imperative step.
- Disabling destroys the owned controller and reports no active controller; re-enabling creates and shows a fresh controller.
- Option changes call the controller's atomic `update()` rather than remounting when target identity is unchanged.
- Target replacement creates a new controller only after the new target is available; the previous controller is then destroyed.
- Unmount always destroys the owned controller exactly once.
- Adapter errors are not swallowed. They are exposed through framework error handling after cleanup has contained owned resources.
- Each adapter owns only controllers it creates.

## React

```tsx
import { useAnnotation } from 'hanamaru-annotations/react'

function Claim() {
  const target = useRef<HTMLSpanElement>(null)
const annotation = useAnnotation(target, {
  mark: 'underline',
  note: 'Still attached',
})
  return <span ref={target}>Claim</span>
}
```

The complete signature is `useAnnotation(ref, options, { enabled = true } = {})`. It returns a read-only `RefObject<AnnotationController | null>`. It uses layout-phase creation in the browser, is Strict Mode idempotent, and compares canonical option values rather than object identity.

## Vue 3.5

```vue
<script setup>
import { ref } from 'vue'
import { useAnnotation } from 'hanamaru-annotations/vue'

const target = ref()
const annotation = useAnnotation(target, {
  mark: 'circle',
  note: 'Vue lifecycle',
})
</script>
```

The complete signature is `useAnnotation(targetRef, optionsOrRef, enabledOrRef = true)`. It returns `ShallowRef<AnnotationController | null>`. It uses `onMounted`, `watch`, and `onBeforeUnmount`; deep option tracking is explicit and finite over canonical fields. No Vue 4 support is claimed before a real Vue 4 release is tested.

## Svelte 5

```svelte
<script>
  import { annotation } from 'hanamaru-annotations/svelte'
</script>

<span use:annotation={{ mark: 'highlight', note: 'Svelte action' }}>
  Claim
</span>
```

The `annotation(node, input)` action accepts annotation options plus adapter-only `enabled` and `onController`. It returns `update(nextInput)` and `destroy()`.

`onController` has the exact signature `(controller: AnnotationController | null) => void`:

- after a controller is created and `show()` is accepted, it receives that controller;
- same-target option updates retain the controller and do not call it again;
- disabling or action destruction destroys the controller, then reports `null`;
- target replacement reports `null` after old teardown, then the new controller after successful show;
- creation, update, or show failure contains owned resources, reports `null` once when a controller had been reported, and rethrows through Svelte;
- a throwing callback is treated as user-code failure: the adapter destroys owned state, then rethrows the callback error.

## Scope

Adapters cover manual Annotation only. Story, Group, Selection, serialization, plugins, automatic triggers, and Shadow scopes remain usable through their framework-free APIs and documented lifecycle recipes. Runtime JavaScript rejects a wrapper `trigger` field with `HanamaruConfigError`; declarations omit it. Adding wrapper-specific Story or Group abstractions is excluded from `0.1.0`.

## Verification

Dedicated framework fixtures verify mount-and-show, enabled toggles, update, target replacement, unmount, error propagation, React Strict Mode double invocation, Vue reactive options, every Svelte callback transition, SSR import and render safety, reduced motion inheritance, and no duplicate overlays or ARIA tokens.

The supported peer ranges are verified at both endpoints available at implementation time:

- React 18.2.0 and 19.2.8;
- Vue 3.5.0 and 3.5.40;
- Svelte 5.0.0 and 5.56.7.

CI uses isolated fixture installs or npm aliases so every endpoint actually loads. A peer range is narrowed if an endpoint cannot pass. Bundle tests externalize peers and enforce each 4,096-byte gzip cap. Declaration fixtures compile representative TSX, Vue-oriented TypeScript, and Svelte action usage against both tested endpoints where their declarations differ.
