import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import {
  createNpmInvocation,
  createSignalSupervisor,
  executeEndpoints,
  preflightFixtureSets,
  runCommand,
  runEndpoint,
  selectEndpoints,
} from './run-endpoints.mjs'

test('selectors accept only exact own framework keys', () => {
  for (const selector of ['constructor', 'toString', '__proto__']) {
    assert.throws(
      () => selectEndpoints([selector]),
      /usage: node tests\/framework\/run-endpoints\.mjs/,
    )
  }
})

test('all preflights every framework fixture set before execution', async () => {
  const endpoints = selectEndpoints(['all'])
  const checked = []

  await assert.rejects(
    preflightFixtureSets(endpoints, {
      accessFile: async (path) => {
        checked.push(path)
        throw new Error('absent')
      },
    }),
    (error) => {
      assert.match(error.message, /missing react runtime fixture/)
      assert.match(error.message, /missing vue runtime fixture/)
      assert.match(error.message, /missing svelte runtime fixture/)
      return true
    },
  )

  assert.equal(checked.length, 3)
})

test('endpoint execution continues after a prior endpoint failure', async () => {
  const endpoints = selectEndpoints(['react'])
  const calls = []
  const fixtureSets = new Map([['react', { runtime: 'fixture' }]])

  await assert.rejects(
    executeEndpoints(endpoints, fixtureSets, {
      runEndpointImpl: async (endpoint) => {
        calls.push(endpoint.version)
        if (endpoint.version === '18.2.0') {
          throw new Error('first failed')
        }
      },
    }),
    (error) => {
      assert.ok(error instanceof AggregateError)
      assert.match(error.message, /react@18\.2\.0: first failed/)
      return true
    },
  )

  assert.deepEqual(calls, ['18.2.0', '19.2.8'])
})

test('npm invocation uses the current Node for npm_execpath', () => {
  assert.deepEqual(
    createNpmInvocation(['install', 'react@18.2.0'], {
      platform: 'win32',
      env: { npm_execpath: 'C:\\npm\\bin\\npm-cli.js' },
      execPath: 'C:\\node.exe',
    }),
    {
      command: 'C:\\node.exe',
      arguments: ['C:\\npm\\bin\\npm-cli.js', 'install', 'react@18.2.0'],
    },
  )
})

test('npm invocation uses an explicit safe Windows command fallback', () => {
  assert.deepEqual(
    createNpmInvocation(['install', 'react@18.2.0'], {
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      execPath: 'C:\\node.exe',
    }),
    {
      command: 'C:\\Windows\\System32\\cmd.exe',
      arguments: ['/d', '/s', '/c', 'npm.cmd', 'install', 'react@18.2.0'],
    },
  )

  assert.throws(
    () =>
      createNpmInvocation(['install', 'react@18.2.0&calc'], {
        platform: 'win32',
        env: {},
        execPath: 'C:\\node.exe',
      }),
    /unsafe npm argument/,
  )
})

test('runEndpoint preserves both the primary and cleanup failure', async () => {
  const primary = new Error('fixture failed')
  const cleanup = new Error('cleanup failed')

  await assert.rejects(
    runEndpoint(
      { framework: 'react', version: '18.2.0' },
      {},
      {
        createDirectory: async () => '/tmp/isolated-endpoint',
        execute: async () => {
          throw primary
        },
        cleanup: async () => {
          throw cleanup
        },
      },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.cause, primary)
      assert.equal(error.cleanupCause, cleanup)
      assert.deepEqual(error.errors, [primary, cleanup])
      assert.match(error.message, /fixture failed/)
      assert.match(error.message, /cleanup failed/)
      return true
    },
  )
})

test('runEndpoint surfaces a cleanup-only failure', async () => {
  const cleanup = new Error('cleanup failed')

  await assert.rejects(
    runEndpoint(
      { framework: 'vue', version: '3.5.0' },
      {},
      {
        createDirectory: async () => '/tmp/isolated-endpoint',
        execute: async () => {},
        cleanup: async () => {
          throw cleanup
        },
      },
    ),
    cleanup,
  )
})

test('signal supervisor forwards termination and restores handlers', async () => {
  const processObject = new EventEmitter()
  const supervisor = createSignalSupervisor({
    processObject,
    forceKillDelay: Infinity,
  })
  const child = new EventEmitter()
  const kills = []
  child.kill = (signal) => {
    kills.push(signal)
    return true
  }

  const beforeInt = processObject.listenerCount('SIGINT')
  const beforeTerm = processObject.listenerCount('SIGTERM')
  supervisor.install()
  supervisor.activate(child)

  processObject.emit('SIGTERM', 'SIGTERM')
  assert.equal(supervisor.signal, 'SIGTERM')
  assert.deepEqual(kills, ['SIGTERM'])

  supervisor.release(child)
  supervisor.dispose()
  assert.equal(processObject.listenerCount('SIGINT'), beforeInt)
  assert.equal(processObject.listenerCount('SIGTERM'), beforeTerm)
})

test('signal supervisor terminates the POSIX child process group', () => {
  const processObject = new EventEmitter()
  const kills = []
  processObject.platform = 'linux'
  processObject.kill = (processId, signal) => {
    kills.push([processId, signal])
  }
  const supervisor = createSignalSupervisor({
    processObject,
    forceKillDelay: Infinity,
  })
  const child = new EventEmitter()
  child.pid = 47
  child.kill = () => {
    throw new Error('direct child fallback was not expected')
  }

  supervisor.install()
  supervisor.activate(child)
  processObject.emit('SIGINT')

  assert.deepEqual(kills, [[-47, 'SIGINT']])
  supervisor.release(child)
  supervisor.dispose()
})

test('runCommand awaits child close after a parent termination signal', async () => {
  const processObject = new EventEmitter()
  const supervisor = createSignalSupervisor({
    processObject,
    forceKillDelay: Infinity,
  })
  const child = new EventEmitter()
  const events = []
  child.kill = (signal) => {
    events.push(`kill:${signal}`)
    return true
  }
  const spawnChild = () => child

  supervisor.install()
  const command = runCommand('fixture', [], {
    label: 'test fixture',
    spawnChild,
    supervisor,
  })
  processObject.emit('SIGINT', 'SIGINT')

  let settled = false
  command.catch(() => {
    settled = true
  })
  await Promise.resolve()
  assert.equal(settled, false)

  events.push('close')
  child.emit('close', null, 'SIGINT')
  await assert.rejects(command, /test fixture failed with signal SIGINT/)
  assert.deepEqual(events, ['kill:SIGINT', 'close'])
  assert.equal(supervisor.activeChild, null)
  supervisor.dispose()
})

test('parent termination cleans the endpoint before returning a nonzero result', async () => {
  const processObject = new EventEmitter()
  const supervisor = createSignalSupervisor({
    processObject,
    forceKillDelay: Infinity,
  })
  const child = new EventEmitter()
  const events = []
  child.kill = (signal) => {
    events.push(`kill:${signal}`)
    queueMicrotask(() => {
      events.push('close')
      child.emit('close', null, signal)
    })
    return true
  }
  const endpoint = selectEndpoints(['vue', '3.5.0'])[0]

  supervisor.install()
  const execution = executeEndpoints(
    [endpoint],
    new Map([['vue', { runtime: 'fixture' }]]),
    {
      supervisor,
      operations: {
        createDirectory: async () => {
          events.push('temp')
          return '/tmp/isolated-endpoint'
        },
        execute: async () => {
          const command = runCommand('fixture', [], {
            label: 'test fixture',
            spawnChild: () => child,
            supervisor,
          })
          processObject.emit('SIGTERM')
          await command
        },
        cleanup: async () => {
          events.push('cleanup')
        },
      },
    },
  )

  await assert.rejects(execution, (error) => {
    assert.equal(error.name, 'ParentTerminationError')
    assert.equal(error.exitCode, 143)
    return true
  })
  assert.deepEqual(events, [
    'temp',
    'kill:SIGTERM',
    'close',
    'cleanup',
  ])
  assert.equal(supervisor.activeChild, null)
  supervisor.dispose()
})
