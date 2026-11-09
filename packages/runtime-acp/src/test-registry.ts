// Fixtures for the registry and discovery tests (not exported from the package).
export const FAKE_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="currentColor" d="M0 0h16v16z"/></svg>';
/** A registry in the ACP format: two valid entries and four that must be ignored. */
export const fakeRegistry = {
  version: '1.0.0',
  agents: [
    {
      id: 'fakebin',
      name: 'Fake Bin',
      version: '1.2.3',
      description: 'A binary agent',
      repository: 'https://example.com/fakebin',
      icon: 'https://cdn.example.com/fakebin.svg',
      distribution: { binary: { 'darwin-aarch64': { archive: 'https://x/a.zip', cmd: './fakebin', args: ['acp'] },
          'darwin-x86_64': { archive: 'https://x/a.zip', cmd: './fakebin', args: ['acp'] },
          'linux-x86_64': { archive: 'https://x/a.tgz', cmd: './fakebin', args: ['acp'] },
          'linux-aarch64': { archive: 'https://x/a.tgz', cmd: './fakebin', args: ['acp'] },
          'windows-x86_64': { archive: 'https://x/a.zip', cmd: './fakebin.exe', args: ['acp'] } } },
    },
    { id: 'fakenpx', name: 'Fake Npx', version: '0.1.0', icon: 'https://cdn.example.com/fakenpx.svg', distribution: { npx: { package: 'fake-npx@0.1.0', args: ['--acp'] } } },
    { id: 'Bad Id', name: 'bad', version: '1', distribution: { npx: { package: 'x' } } },
    { id: 'nodist', name: 'No dist', version: '1' },
    { id: 'evilpkg', name: 'Evil', version: '1', distribution: { npx: { package: '--eval=process.exit()' } } },
    { id: 'evilcmd', name: 'Evil', version: '1', distribution: { binary: { 'linux-x86_64': { archive: 'x', cmd: '../../bin/sh -c' } } } },
  ],
};

