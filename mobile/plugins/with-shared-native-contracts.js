const { withDangerousMod } = require('expo/config-plugins');
const { copyFile, mkdir } = require('node:fs/promises');
const path = require('node:path');

// Pods own these contracts. Generate extension inputs before Xcode scans the target folders.
module.exports = config => withDangerousMod(config, ['ios', async config => {
  const root = config.modRequest.projectRoot;
  for (const [module, target, files] of [
    ['shuddhalekhan-speech', 'transcript-keyboard', ['KeyboardSessionProtocol.swift', 'KeyboardSessionChannel.swift']],
    ['shuddhalekhan-agent-activity', 'agent-activity', ['AgentActivityAttributes.swift']],
  ]) {
    const destination = path.join(root, 'targets', target);
    await mkdir(destination, { recursive: true });
    for (const file of files) {
      await copyFile(path.join(root, 'modules', module, 'ios', file), path.join(destination, file));
    }
  }
  return config;
}]);
