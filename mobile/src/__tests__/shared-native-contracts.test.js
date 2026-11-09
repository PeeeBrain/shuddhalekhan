const { test, expect } = require('bun:test');
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const withSharedNativeContracts = require('../../plugins/with-shared-native-contracts');

// A stale extension contract can silently break background commands or ActivityKit decoding.
test('prebuild generates extension contracts and replaces stale inputs on repeat builds', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'native-contracts-'));
  const contracts = [
    ['shuddhalekhan-speech', 'transcript-keyboard', 'KeyboardSessionProtocol.swift'],
    ['shuddhalekhan-speech', 'transcript-keyboard', 'KeyboardSessionChannel.swift'],
    ['shuddhalekhan-agent-activity', 'agent-activity', 'AgentActivityAttributes.swift'],
  ];
  try {
    for (const [module, , file] of contracts) {
      const directory = path.join(root, 'modules', module, 'ios');
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, file), await readFile(path.join(__dirname, '../../modules', module, 'ios', file)));
    }
    const config = withSharedNativeContracts({ name: 'test', slug: 'test' });
    const generate = () => config.mods.ios.dangerous({ ...config, modRequest: { projectRoot: root } });
    await generate();
    for (const [, target, file] of contracts) await writeFile(path.join(root, 'targets', target, file), 'stale');
    await generate();
    for (const [module, target, file] of contracts) {
      expect(await readFile(path.join(root, 'targets', target, file), 'utf8'))
        .toBe(await readFile(path.join(root, 'modules', module, 'ios', file), 'utf8'));
    }
    await rm(path.join(root, 'modules', contracts[0][0], 'ios', contracts[0][2]));
    await expect(generate()).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
