import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FleetRegistryStore, publicHostConfig } from './fleet-registry.js'
import { sshTunnelArgs } from './fleet-connectors.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })))
})

async function registry(): Promise<FleetRegistryStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-fleet-'))
  cleanup.push(directory)
  const store = new FleetRegistryStore(directory)
  await store.load()
  return store
}

describe('FleetRegistryStore', () => {
  it('persists tokens in a user-only atomic registry without exposing them publicly', async () => {
    const store = await registry()
    const host = await store.create({
      label: 'Local observer',
      transport: 'direct',
      baseUrl: 'http://127.0.0.1:4311',
      token: 'fleet-secret',
      controlToken: 'control-secret',
      controlEnabled: true,
    })
    const stat = await fs.stat(store.file)
    const directoryStat = await fs.stat(store.directory)
    expect(stat.mode & 0o777).toBe(0o600)
    expect(directoryStat.mode & 0o777).toBe(0o700)
    expect(publicHostConfig(host)).toMatchObject({
      id: host.id,
      hasToken: true,
      hasControlToken: true,
      controlEnabled: true,
    })
    expect(publicHostConfig(host)).not.toHaveProperty('token')
    expect(publicHostConfig(host)).not.toHaveProperty('controlToken')

    const restored = new FleetRegistryStore(store.directory)
    await restored.load()
    expect(restored.get(host.id)?.token).toBe('fleet-secret')
    expect(restored.get(host.id)?.controlToken).toBe('control-secret')
    await expect(store.create({
      label: 'Missing control credential',
      transport: 'direct',
      baseUrl: 'http://127.0.0.1:4312',
      token: 'read-secret',
      controlEnabled: true,
    })).rejects.toThrow(/control token/i)
  })

  it('restricts direct and Tailscale destinations and builds one fixed SSH tunnel', async () => {
    const store = await registry()
    await expect(store.create({
      label: 'Unsafe direct',
      transport: 'direct',
      baseUrl: 'http://example.com:4311',
      token: 'secret',
    })).rejects.toThrow('loopback')
    await expect(store.create({
      label: 'Unsafe tailnet',
      transport: 'tailscale',
      baseUrl: 'https://example.com',
      token: 'secret',
    })).rejects.toThrow('Tailscale')

    const tailnet = await store.create({
      label: 'Tailnet workstation',
      transport: 'tailscale',
      baseUrl: 'https://build-box.tailnet.ts.net:4311',
      token: 'secret',
    })
    expect(tailnet.baseUrl).toBe('https://build-box.tailnet.ts.net:4311')

    const ssh = await store.create({
      label: 'SSH workstation',
      transport: 'ssh',
      token: 'secret',
      sshTarget: 'builder@workstation',
      sshPort: 2222,
      localPort: 14311,
      remotePort: 4311,
    })
    expect(sshTunnelArgs(ssh, 3_500)).toEqual([
      '-N', '-T',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=4',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=10',
      '-o', 'ServerAliveCountMax=2',
      '-p', '2222',
      '-L', '127.0.0.1:14311:127.0.0.1:4311',
      '--',
      'builder@workstation',
    ])
    await expect(store.create({
      label: 'Conflicting SSH workstation',
      transport: 'ssh',
      token: 'secret',
      sshTarget: 'builder@another-workstation',
      localPort: 14311,
      remotePort: 4311,
    })).rejects.toThrow('unique local tunnel ports')
  })

  it('recovers from a transient write failure without committing memory early', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-fleet-recovery-'))
    cleanup.push(root)
    const directory = path.join(root, 'state')
    const store = new FleetRegistryStore(directory)
    await store.load()
    await fs.writeFile(directory, 'temporarily blocks state directory creation')

    await expect(store.create({
      label: 'First attempt',
      transport: 'direct',
      baseUrl: 'http://127.0.0.1:4311',
      token: 'secret',
    })).rejects.toThrow()
    expect(store.list()).toEqual([])

    await fs.rm(directory)
    const recovered = await store.create({
      label: 'Recovered observer',
      transport: 'direct',
      baseUrl: 'http://127.0.0.1:4311',
      token: 'secret',
    })
    expect(store.list().map((host) => host.id)).toEqual([recovered.id])

    const restored = new FleetRegistryStore(directory)
    await restored.load()
    expect(restored.get(recovered.id)?.label).toBe('Recovered observer')
  })

  it('preserves a persisted registry with conflicting enabled SSH ports', async () => {
    const store = await registry()
    await store.create({
      label: 'First SSH host',
      transport: 'ssh',
      token: 'secret',
      sshTarget: 'builder@first-host',
      localPort: 14311,
      remotePort: 4311,
    })
    const persisted = JSON.parse(await fs.readFile(store.file, 'utf8')) as {
      hosts: Array<Record<string, unknown>>
    }
    persisted.hosts.push({
      ...persisted.hosts[0],
      id: 'second-ssh-host',
      label: 'Second SSH host',
      sshTarget: 'builder@second-host',
    })
    await fs.writeFile(store.file, JSON.stringify(persisted, null, 2), { mode: 0o600 })

    const restored = new FleetRegistryStore(store.directory)
    await restored.load()
    expect(restored.list()).toEqual([])
    expect(restored.error).toContain('preserved')
    expect(await fs.readFile(store.file, 'utf8')).toContain('second-ssh-host')
  })

  it('preserves a malformed or future registry and keeps the central UI loadable', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-ui-fleet-corrupt-'))
    cleanup.push(directory)
    const file = path.join(directory, 'fleet.json')
    await fs.writeFile(file, '{"version":99,"hosts":[{"token":"keep-me"}]}', { mode: 0o600 })
    const store = new FleetRegistryStore(directory)
    await store.load()

    expect(store.list()).toEqual([])
    expect(store.error).toContain('preserved')
    await expect(store.create({
      label: 'Would overwrite',
      transport: 'direct',
      baseUrl: 'http://127.0.0.1:4311',
      token: 'new-token',
    })).rejects.toThrow('preserved')
    expect(await fs.readFile(file, 'utf8')).toContain('"version":99')
    expect(await fs.readFile(file, 'utf8')).toContain('keep-me')
  })
})
