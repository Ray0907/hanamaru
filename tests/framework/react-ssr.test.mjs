import assert from 'node:assert/strict'

delete globalThis.document
delete globalThis.window

const React = await import('react')
const { renderToString } = await import('react-dom/server')
const { useAnnotation } = await import('hanamaru-annotations/react')

let exposed

function Claim() {
  const target = React.useRef(null)
  exposed = useAnnotation(target, { mark: 'underline', note: 'SSR safe' })
  return React.createElement('span', { ref: target }, 'Claim')
}

const markup = renderToString(React.createElement(Claim))

assert.match(markup, /<span>Claim<\/span>/)
assert.equal(exposed.current, null)
assert.equal(typeof document, 'undefined')
assert.equal(typeof window, 'undefined')
