import assert from 'node:assert/strict'

delete globalThis.document
delete globalThis.window

const { createSSRApp, h, ref } = await import('vue')
const { renderToString } = await import('vue/server-renderer')
const { useAnnotation } = await import('hanamaru-annotations/vue')

let exposed

const Claim = {
  setup() {
    const target = ref(null)
    exposed = useAnnotation(target, {
      mark: 'underline',
      note: 'SSR safe',
    })
    return () => h('span', { ref: target }, 'Claim')
  },
}

const markup = await renderToString(createSSRApp(Claim))

assert.match(markup, /<span>Claim<\/span>/)
assert.equal(exposed.value, null)
assert.equal(typeof document, 'undefined')
assert.equal(typeof window, 'undefined')
