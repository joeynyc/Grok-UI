import { describe, expect, it } from 'vitest'
import { createPrivacyTools } from './privacy'

describe('Privacy Mode aliases', () => {
  it('creates stable presentation aliases without preserving sensitive input', () => {
    const privacy = createPrivacyTools(true)
    const sensitive = {
      title: 'Private launch plan',
      path: '/Users/example/Projects/secret-client',
      id: '019f-sensitive-session',
      file: 'customers/priority-account.md',
      content: 'Connect to 192.168.1.42 as Example Person',
      host: 'Joey Studio Mac',
      endpoint: 'https://studio-node.private-tailnet.ts.net:4311',
    }

    const rendered = [
      privacy.sessionTitle(sensitive.title, sensitive.id),
      privacy.path(sensitive.path),
      privacy.identifier(sensitive.id),
      privacy.file(sensitive.file),
      privacy.content(sensitive.content),
      privacy.host(sensitive.host, 'host-studio'),
      privacy.endpoint(sensitive.endpoint),
    ].join(' ')

    expect(privacy.sessionTitle(sensitive.title, sensitive.id)).toBe(
      privacy.sessionTitle(sensitive.title, sensitive.id),
    )
    expect(rendered).not.toContain('secret-client')
    expect(rendered).not.toContain('priority-account')
    expect(rendered).not.toContain('Example Person')
    expect(rendered).not.toContain('192.168.1.42')
    expect(rendered).not.toContain('/Users/')
    expect(rendered).not.toContain('Joey Studio Mac')
    expect(rendered).not.toContain('private-tailnet')
    expect(privacy.host(sensitive.host, 'host-studio')).toBe(
      privacy.host(sensitive.host, 'host-studio'),
    )
  })

  it('keeps operational values unchanged when Privacy Mode is disabled', () => {
    const privacy = createPrivacyTools(false)
    expect(privacy.path('/tmp/project')).toBe('/tmp/project')
    expect(privacy.identifier('session-1')).toBe('session-1')
    expect(privacy.content('visible response')).toBe('visible response')
    expect(privacy.host('Studio Mac')).toBe('Studio Mac')
    expect(privacy.endpoint('https://host.ts.net:4311')).toBe('https://host.ts.net:4311')
  })
})
