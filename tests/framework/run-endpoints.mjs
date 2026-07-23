import { spawn } from 'node:child_process'
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const frameworkDirectory = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(frameworkDirectory, '..', '..')

const endpointMatrix = Object.freeze({
  react: Object.freeze({
    versions: Object.freeze(['18.2.0', '19.2.8']),
    fixtureExtension: 'tsx',
    dependencies(version) {
      if (version === '18.2.0') {
        return [
          'react@18.2.0',
          'react-dom@18.2.0',
          '@types/react@18.3.31',
          '@types/react-dom@18.3.7',
        ]
      }

      return [
        'react@19.2.8',
        'react-dom@19.2.8',
        '@types/react@19.2.17',
        '@types/react-dom@19.2.3',
      ]
    },
  }),
  vue: Object.freeze({
    versions: Object.freeze(['3.5.0', '3.5.40']),
    fixtureExtension: 'ts',
    dependencies: (version) => [`vue@${version}`],
  }),
  svelte: Object.freeze({
    versions: Object.freeze(['5.0.0', '5.56.7']),
    fixtureExtension: 'ts',
    dependencies: (version) => [`svelte@${version}`],
  }),
})

const harnessDependencies = Object.freeze([
  '@playwright/test@1.55.0',
  'esbuild@0.25.0',
  'typescript@5.9.2',
])

function usageError() {
  return new Error(
    'usage: node tests/framework/run-endpoints.mjs react|vue|svelte|all [versions...]',
  )
}

function selectEndpoints(arguments_) {
  const [selection, ...requestedVersions] = arguments_

  if (!selection || (selection !== 'all' && !endpointMatrix[selection])) {
    throw usageError()
  }

  if (selection === 'all' && requestedVersions.length > 0) {
    throw new Error('versions cannot be supplied with the all selector')
  }

  const frameworks = selection === 'all' ? Object.keys(endpointMatrix) : [selection]
  const endpoints = []

  for (const framework of frameworks) {
    const matrix = endpointMatrix[framework]
    const versions = requestedVersions.length > 0 ? requestedVersions : matrix.versions

    for (const version of new Set(versions)) {
      if (!matrix.versions.includes(version)) {
        throw new Error(`unsupported ${framework} endpoint ${version}`)
      }

      endpoints.push({
        framework,
        version,
        fixtureExtension: matrix.fixtureExtension,
        dependencies: matrix.dependencies(version),
      })
    }
  }

  if (endpoints.length === 0) {
    throw new Error('zero endpoint fixtures selected')
  }

  return endpoints
}

function fixturePaths(endpoint) {
  const prefix = join(frameworkDirectory, endpoint.framework)

  return {
    runtime: `${prefix}.test.mjs`,
    ssr: `${prefix}-ssr.test.mjs`,
    types: `${prefix}-types.${endpoint.fixtureExtension}`,
  }
}

async function requireFixture(path, framework, kind) {
  try {
    await access(path)
  } catch {
    throw new Error(`missing ${framework} ${kind} fixture`)
  }
}

async function validateFixtures(endpoint) {
  const fixtures = fixturePaths(endpoint)
  await requireFixture(fixtures.runtime, endpoint.framework, 'runtime')
  await requireFixture(fixtures.ssr, endpoint.framework, 'SSR')
  await requireFixture(fixtures.types, endpoint.framework, 'types')
  return fixtures
}

function run(command, arguments_, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      ...options,
      shell: false,
      stdio: 'inherit',
    })

    child.once('error', rejectPromise)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }

      const ending = signal ? `signal ${signal}` : `exit code ${code}`
      rejectPromise(new Error(`${options.label} failed with ${ending}`))
    })
  })
}

async function installDependencies(directory, dependencies) {
  await run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--save-exact',
      '--save-dev',
      ...dependencies,
    ],
    {
      cwd: directory,
      label: 'isolated npm install',
    },
  )
}

function syntheticPackageManifest(framework) {
  const adapterPath = `./src/adapters/${framework}.js`
  const adapterTypes = `./types/${framework}/index.d.ts`

  return {
    name: 'hanamaru-annotations',
    version: '0.1.0-framework-fixture',
    private: true,
    type: 'module',
    exports: {
      '.': {
        types: './types/index.d.ts',
        import: './src/index.js',
        default: './src/index.js',
      },
      [`./${framework}`]: {
        types: adapterTypes,
        import: adapterPath,
        default: adapterPath,
      },
    },
  }
}

async function createSyntheticPackage(directory, framework) {
  const packageDirectory = join(directory, 'node_modules', 'hanamaru-annotations')
  const adapterTypesDirectory = join(packageDirectory, 'types', framework)

  await mkdir(adapterTypesDirectory, { recursive: true })
  await cp(join(projectRoot, 'src'), join(packageDirectory, 'src'), {
    recursive: true,
  })
  await copyFile(
    join(frameworkDirectory, 'types', 'index.d.ts'),
    join(packageDirectory, 'types', 'index.d.ts'),
  )
  await copyFile(
    join(projectRoot, 'types', framework, 'index.d.ts'),
    join(adapterTypesDirectory, 'index.d.ts'),
  )
  await writeFile(
    join(packageDirectory, 'package.json'),
    `${JSON.stringify(syntheticPackageManifest(framework), null, 2)}\n`,
  )
}

async function copyFixtures(directory, fixtures) {
  const copied = {}

  for (const [kind, source] of Object.entries(fixtures)) {
    const destination = join(directory, source.slice(frameworkDirectory.length + 1))
    await copyFile(source, destination)
    copied[kind] = destination
  }

  return copied
}

async function runBrowserFixture(directory, fixture) {
  await run(
    process.execPath,
    [
      join(directory, 'node_modules', '@playwright', 'test', 'cli.js'),
      'test',
      fixture,
      '--workers=1',
      '--reporter=line',
    ],
    {
      cwd: directory,
      label: 'Playwright browser fixture',
    },
  )
}

async function runSsrFixture(directory, fixture) {
  await run(process.execPath, [fixture], {
    cwd: directory,
    label: 'Node SSR fixture',
  })
}

async function runTypeFixture(directory, fixture) {
  await run(
    process.execPath,
    [
      join(directory, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--noEmit',
      '--strict',
      '--target',
      'ES2020',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--lib',
      'ES2020,DOM,DOM.Iterable',
      '--jsx',
      'react-jsx',
      '--skipLibCheck',
      'false',
      fixture,
    ],
    {
      cwd: directory,
      label: 'TypeScript declaration fixture',
    },
  )
}

async function runEndpoint(endpoint, fixtures) {
  const directory = await mkdtemp(
    join(tmpdir(), `hanamaru-${endpoint.framework}-${endpoint.version}-`),
  )

  try {
    const packageFixture = await readFile(
      join(frameworkDirectory, 'package-fixture.json'),
      'utf8',
    )
    await writeFile(join(directory, 'package.json'), packageFixture)
    await installDependencies(directory, [
      ...harnessDependencies,
      ...endpoint.dependencies,
    ])
    await createSyntheticPackage(directory, endpoint.framework)
    const copiedFixtures = await copyFixtures(directory, fixtures)

    await runBrowserFixture(directory, copiedFixtures.runtime)
    await runSsrFixture(directory, copiedFixtures.ssr)
    await runTypeFixture(directory, copiedFixtures.types)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

async function main() {
  const endpoints = selectEndpoints(process.argv.slice(2))
  let selectedFixtures = 0

  for (const endpoint of endpoints) {
    const fixtures = await validateFixtures(endpoint)
    selectedFixtures += 1
    console.log(`framework-endpoints: ${endpoint.framework}@${endpoint.version}`)
    await runEndpoint(endpoint, fixtures)
  }

  if (selectedFixtures === 0) {
    throw new Error('zero endpoint fixtures selected')
  }
}

main().catch((error) => {
  console.error(`framework-endpoints: ${error.message}`)
  process.exitCode = 1
})
