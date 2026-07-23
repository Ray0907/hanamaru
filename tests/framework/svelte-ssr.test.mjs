import assert from 'node:assert/strict'

import { build } from 'esbuild'
import { compile } from 'svelte/compiler'

delete globalThis.document
delete globalThis.window

const component = compile(String.raw`
  <script>
    import { annotation } from 'hanamaru-annotations/svelte'
    export let input = { mark: 'underline', note: 'SSR safe' }
  </script>
  <span use:annotation={input}>Claim</span>
`, {
  filename: 'SsrClaim.svelte',
  generate: 'server',
})

const entry = String.raw`
  import { render } from 'svelte/server'
  import Claim from './SsrClaim.js'
  globalThis.__svelteSsrMarkup = render(Claim).html
`

const result = await build({
  bundle: true,
  format: 'esm',
  platform: 'node',
  entryPoints: ['fixture:ssr-entry'],
  plugins: [{
    name: 'virtual-svelte-ssr',
    setup(builder) {
      builder.onResolve(
        { filter: /^fixture:ssr-entry$/ },
        () => ({ namespace: 'fixture', path: 'entry' }),
      )
      builder.onResolve(
        { filter: /^\.\/SsrClaim\.js$/ },
        () => ({ namespace: 'fixture', path: 'component' }),
      )
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
        contents: args.path === 'entry' ? entry : component.js.code,
        loader: 'js',
        resolveDir: process.cwd(),
      }))
    },
  }],
  write: false,
})

await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

assert.match(globalThis.__svelteSsrMarkup, /<span>Claim<\/span>/)
assert.equal(typeof document, 'undefined')
assert.equal(typeof window, 'undefined')
