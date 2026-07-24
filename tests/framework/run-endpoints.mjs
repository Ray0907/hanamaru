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

export function selectEndpoints(arguments_) {
  const [selection, ...requestedVersions] = arguments_

  if (
    !selection ||
    (selection !== 'all' && !Object.hasOwn(endpointMatrix, selection))
  ) {
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

async function requireFixture(path, framework, kind, accessFile) {
  try {
    await accessFile(path)
  } catch {
    throw new Error(`missing ${framework} ${kind} fixture`)
  }
}

async function validateFixtures(endpoint, accessFile) {
  const fixtures = fixturePaths(endpoint)
  await requireFixture(fixtures.runtime, endpoint.framework, 'runtime', accessFile)
  await requireFixture(fixtures.ssr, endpoint.framework, 'SSR', accessFile)
  await requireFixture(fixtures.types, endpoint.framework, 'types', accessFile)
  return fixtures
}

export async function preflightFixtureSets(
  endpoints,
  { accessFile = access } = {},
) {
  const fixturesByFramework = new Map()
  const failures = []
  const preflightedFrameworks = new Set()

  for (const endpoint of endpoints) {
    if (preflightedFrameworks.has(endpoint.framework)) continue
    preflightedFrameworks.add(endpoint.framework)

    try {
      fixturesByFramework.set(
        endpoint.framework,
        await validateFixtures(endpoint, accessFile),
      )
    } catch (error) {
      failures.push(error)
    }
  }

  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      failures.map((failure) => failure.message).join('; '),
    )
  }

  return fixturesByFramework
}

const unsafeWindowsCommandArgument = /[&|<>^%\r\n]/

export function createNpmInvocation(
  arguments_,
  {
    platform = process.platform,
    env = process.env,
    execPath = process.execPath,
  } = {},
) {
  if (env.npm_execpath) {
    return {
      command: execPath,
      arguments: [env.npm_execpath, ...arguments_],
    }
  }

  if (platform === 'win32') {
    for (const argument of arguments_) {
      if (unsafeWindowsCommandArgument.test(argument)) {
        throw new Error(`unsafe npm argument: ${argument}`)
      }
    }

    return {
      command: env.ComSpec || env.COMSPEC || 'cmd.exe',
      arguments: ['/d', '/s', '/c', 'npm.cmd', ...arguments_],
    }
  }

  return {
    command: 'npm',
    arguments: arguments_,
  }
}

class ParentTerminationError extends Error {
  constructor(signal, options = {}) {
    super(`terminated by ${signal}`, options)
    this.name = 'ParentTerminationError'
    this.signal = signal
    this.exitCode = signal === 'SIGINT' ? 130 : 143
  }
}

export function createSignalSupervisor({
  processObject = process,
  forceKillDelay = 5_000,
  spawnTreeKiller = spawn,
} = {}) {
  let activeChild = null
  let activeTermination = null
  let forceKillTimer = null
  let installed = false
  let signal = null
  const handlers = new Map()

  function clearForceKill() {
    if (forceKillTimer !== null) {
      clearTimeout(forceKillTimer)
      forceKillTimer = null
    }
  }

  function directlyTerminateChild(child, requestedSignal) {
    try {
      child.kill(requestedSignal)
    } catch {
      // An already-exited child is a successful termination race.
    }
  }

  function terminatePosixGroup(child, requestedSignal) {
    if (
      Number.isInteger(child.pid) &&
      typeof processObject.kill === 'function'
    ) {
      try {
        processObject.kill(-child.pid, requestedSignal)
        return
      } catch {
        // Fall back when the child did not establish a process group.
      }
    }

    directlyTerminateChild(child, requestedSignal)
  }

  function terminateWindowsTree(child, requestedSignal) {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
      directlyTerminateChild(child, requestedSignal)
      return Promise.resolve()
    }

    let taskkill
    try {
      taskkill = spawnTreeKiller(
        'taskkill',
        ['/PID', String(child.pid), '/T', '/F'],
        {
          shell: false,
          stdio: 'ignore',
          windowsHide: true,
        },
      )
    } catch {
      directlyTerminateChild(child, requestedSignal)
      return Promise.resolve()
    }

    return new Promise((resolvePromise) => {
      let settled = false

      function finish(succeeded) {
        if (settled) return
        settled = true
        if (!succeeded) directlyTerminateChild(child, requestedSignal)
        resolvePromise()
      }

      taskkill.once('error', () => finish(false))
      taskkill.once('close', (code) => finish(code === 0))
    })
  }

  function killActive(requestedSignal) {
    if (!activeChild) return

    if (processObject.platform === 'win32') {
      if (activeTermination?.child !== activeChild) {
        activeTermination = {
          child: activeChild,
          promise: terminateWindowsTree(activeChild, requestedSignal),
        }
      }
      return
    }

    terminatePosixGroup(activeChild, requestedSignal)
    clearForceKill()
    if (Number.isFinite(forceKillDelay)) {
      const child = activeChild
      forceKillTimer = setTimeout(() => {
        if (activeChild !== child) return
        terminatePosixGroup(child, 'SIGKILL')
      }, forceKillDelay)
      forceKillTimer.unref?.()
    }
  }

  function forward(requestedSignal) {
    signal ||= requestedSignal
    killActive(signal)
  }

  return {
    get activeChild() {
      return activeChild
    },
    get signal() {
      return signal
    },
    install() {
      if (installed) return
      installed = true

      for (const signalName of ['SIGINT', 'SIGTERM']) {
        const handler = () => forward(signalName)
        handlers.set(signalName, handler)
        processObject.on(signalName, handler)
      }
    },
    activate(child) {
      if (activeChild && activeChild !== child) {
        throw new Error('framework endpoint child process overlap')
      }

      activeChild = child
      if (signal) killActive(signal)
    },
    async release(child) {
      if (activeChild !== child) return
      if (activeTermination?.child === child) {
        await activeTermination.promise
      }
      if (activeChild !== child) return
      activeChild = null
      activeTermination = null
      clearForceKill()
    },
    throwIfTerminating() {
      if (signal) throw new ParentTerminationError(signal)
    },
    dispose() {
      clearForceKill()
      if (installed) {
        for (const [signalName, handler] of handlers) {
          processObject.removeListener(signalName, handler)
        }
      }
      handlers.clear()
      installed = false
      activeChild = null
      activeTermination = null
    },
  }
}

export function runCommand(
  command,
  arguments_,
  {
    label,
    supervisor = null,
    spawnChild = spawn,
    ...spawnOptions
  } = {},
) {
  supervisor?.throwIfTerminating()
  const child = spawnChild(command, arguments_, {
    ...spawnOptions,
    detached: process.platform !== 'win32',
    shell: false,
    stdio: 'inherit',
  })

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false

    async function settle(error) {
      if (settled) return
      settled = true
      await supervisor?.release(child)

      if (error) rejectPromise(error)
      else resolvePromise()
    }

    child.once('error', (error) => {
      void settle(new Error(`${label} failed to start`, { cause: error }))
    })
    child.once('close', (code, signal) => {
      if (code === 0) {
        void settle()
        return
      }

      const ending = signal ? `signal ${signal}` : `exit code ${code}`
      void settle(new Error(`${label} failed with ${ending}`))
    })

    supervisor?.activate(child)
  })
}

async function installDependencies(directory, dependencies, supervisor) {
  const npm = createNpmInvocation([
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    '--save-exact',
    '--save-dev',
    ...dependencies,
  ])

  await runCommand(npm.command, npm.arguments, {
    cwd: directory,
    label: 'isolated npm install',
    supervisor,
  })
}

async function installBrowserFixture(directory, supervisor) {
  await runCommand(
    process.execPath,
    [
      join(directory, 'node_modules', '@playwright', 'test', 'cli.js'),
      'install',
      'chromium',
    ],
    {
      cwd: directory,
      label: 'Playwright browser install',
      supervisor,
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

async function runBrowserFixture(directory, fixture, supervisor) {
  await runCommand(
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
      supervisor,
    },
  )
}

async function runSsrFixture(directory, fixture, supervisor) {
  await runCommand(process.execPath, [fixture], {
    cwd: directory,
    label: 'Node SSR fixture',
    supervisor,
  })
}

async function runTypeFixture(directory, fixture, supervisor) {
  await runCommand(
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
      supervisor,
    },
  )
}

async function executeEndpoint(directory, endpoint, fixtures, supervisor) {
  supervisor?.throwIfTerminating()
  const packageFixture = await readFile(
    join(frameworkDirectory, 'package-fixture.json'),
    'utf8',
  )
  await writeFile(join(directory, 'package.json'), packageFixture)
  await installDependencies(
    directory,
    [...harnessDependencies, ...endpoint.dependencies],
    supervisor,
  )
  await installBrowserFixture(directory, supervisor)
  supervisor?.throwIfTerminating()
  await createSyntheticPackage(directory, endpoint.framework)
  const copiedFixtures = await copyFixtures(directory, fixtures)

  await runBrowserFixture(directory, copiedFixtures.runtime, supervisor)
  await runSsrFixture(directory, copiedFixtures.ssr, supervisor)
  await runTypeFixture(directory, copiedFixtures.types, supervisor)
}

const defaultEndpointOperations = Object.freeze({
  createDirectory(endpoint) {
    return mkdtemp(
      join(tmpdir(), `hanamaru-${endpoint.framework}-${endpoint.version}-`),
    )
  },
  execute: executeEndpoint,
  cleanup(directory) {
    return rm(directory, { force: true, recursive: true })
  },
})

export async function runEndpoint(
  endpoint,
  fixtures,
  operations = defaultEndpointOperations,
  supervisor = null,
) {
  let cleanupFailure = null
  let directory = null
  let primaryFailure = null

  try {
    supervisor?.throwIfTerminating()
    directory = await operations.createDirectory(endpoint)
    await operations.execute(directory, endpoint, fixtures, supervisor)
  } catch (error) {
    primaryFailure = error
  } finally {
    if (directory !== null) {
      try {
        await operations.cleanup(directory, endpoint)
      } catch (error) {
        cleanupFailure = error
      }
    }
  }

  if (primaryFailure && cleanupFailure) {
    const aggregate = new AggregateError(
      [primaryFailure, cleanupFailure],
      `${endpoint.framework}@${endpoint.version} failed: ${primaryFailure.message}; cleanup failed: ${cleanupFailure.message}`,
      { cause: primaryFailure },
    )
    aggregate.cleanupCause = cleanupFailure
    throw aggregate
  }

  if (primaryFailure) throw primaryFailure
  if (cleanupFailure) throw cleanupFailure
}

function endpointFailure(endpoint, error) {
  const failure = new Error(
    `${endpoint.framework}@${endpoint.version}: ${error.message}`,
    { cause: error },
  )
  failure.endpoint = endpoint
  return failure
}

export async function executeEndpoints(
  endpoints,
  fixturesByFramework,
  {
    runEndpointImpl = runEndpoint,
    operations = defaultEndpointOperations,
    supervisor = null,
  } = {},
) {
  const failures = []

  for (const endpoint of endpoints) {
    if (supervisor?.signal) break

    console.log(`framework-endpoints: ${endpoint.framework}@${endpoint.version}`)

    try {
      await runEndpointImpl(
        endpoint,
        fixturesByFramework.get(endpoint.framework),
        operations,
        supervisor,
      )
    } catch (error) {
      failures.push(endpointFailure(endpoint, error))
    }
  }

  if (supervisor?.signal) {
    const endpointFailures =
      failures.length === 0
        ? undefined
        : new AggregateError(
            failures,
            failures.map((failure) => failure.message).join('; '),
          )
    throw new ParentTerminationError(supervisor.signal, {
      cause: endpointFailures,
    })
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      failures.map((failure) => failure.message).join('; '),
    )
  }
}

async function main(arguments_ = process.argv.slice(2)) {
  const endpoints = selectEndpoints(arguments_)
  const supervisor = createSignalSupervisor()
  supervisor.install()

  try {
    const fixturesByFramework = await preflightFixtureSets(endpoints)
    supervisor.throwIfTerminating()
    await executeEndpoints(endpoints, fixturesByFramework, { supervisor })
  } finally {
    supervisor.dispose()
  }
}

const isDirectInvocation =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isDirectInvocation) {
  main().catch((error) => {
    console.error(`framework-endpoints: ${error.message}`)
    process.exitCode = error.exitCode || 1
  })
}
