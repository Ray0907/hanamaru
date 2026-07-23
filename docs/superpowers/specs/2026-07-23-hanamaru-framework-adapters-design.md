# Hanamaru Framework Adapter Design

**Date:** 2026-07-23  
**Status:** User-approved design; pending independent spec review

## Objective

Provide thin lifecycle adapters for React, Vue 3.5, and Svelte 5. Adapters create, atomically update, expose, and destroy the same framework-free Annotation controller; they do not reimplement rendering or add framework code to the core bundle.

## Shared Rules

- Server rendering imports are safe and perform no DOM work.
- Controllers are created only after the host element is mounted in a browser.
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

`useAnnotation(ref, options)` returns a read-only `RefObject<AnnotationController | null>`. It uses layout-phase creation in the browser, is Strict Mode idempotent, and compares canonical option values rather than object identity. The tested peer is React 19.2.8 while the public range remains `>=18.2 <20`.

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

`useAnnotation(targetRef, optionsOrRef)` returns `ShallowRef<AnnotationController | null>`. It uses `onMounted`, `watch`, and `onBeforeUnmount`; deep option tracking is explicit and finite over canonical fields. The supported and tested peer range is `>=3.5 <4`. No Vue 4 support is claimed before a real Vue 4 release is tested.

## Svelte 5

```svelte
<script>
  import { annotation } from 'hanamaru-annotations/svelte'
</script>

<span use:annotation={{ mark: 'highlight', note: 'Svelte action' }}>
  Claim
</span>
```

The `annotation(node, options)` action returns `update(nextOptions)` and `destroy()`. It works with Svelte 5 action semantics and exposes the controller through an optional `onController(controller)` callback in adapter options rather than a framework-specific store.

## Scope

Adapters cover Annotation only. Story, Group, Selection, serialization, plugins, and Shadow scopes remain usable through their framework-free APIs and documented lifecycle recipes. Adding wrapper-specific Story or Group abstractions is excluded from `0.1.0`.

## Verification

Dedicated framework fixtures verify mount, update, target replacement, unmount, error propagation, React Strict Mode double invocation, Vue reactive options, Svelte action updates, SSR import and render safety, reduced motion inheritance, and no duplicate overlays or ARIA tokens. Bundle tests externalize peers and enforce each 4,096-byte gzip cap. Declaration fixtures compile representative TSX, Vue-oriented TypeScript, and Svelte action usage.
