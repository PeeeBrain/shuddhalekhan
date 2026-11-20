const { IOSConfig, withDangerousMod, withXcodeProject } = require('expo/config-plugins');
const { copyFile, mkdir } = require('node:fs/promises');
const path = require('node:path');

const intentsFile = 'SystemDictationIntents.swift';

// Pods own these contracts. Generate extension inputs before Xcode scans the target folders.
module.exports = config => {
  config = withDangerousMod(config, ['ios', async config => {
    const { projectRoot: root, platformProjectRoot, projectName } = config.modRequest;
    for (const [module, target, files] of [
      ['shuddhalekhan-speech', 'transcript-keyboard', [
        'DictationStyle.swift', 'KeyboardInsertion.swift', 'KeyboardSessionProtocol.swift', 'KeyboardSessionChannel.swift',
      ]],
      ['shuddhalekhan-agent-activity', 'agent-activity', ['AgentActivityAttributes.swift']],
      ['shuddhalekhan-speech', 'agent-activity', ['SystemDictationAttributes.swift']],
    ]) {
      const destination = path.join(root, 'targets', target);
      await mkdir(destination, { recursive: true });
      for (const file of files) {
        await copyFile(path.join(root, 'modules', module, 'ios', file), path.join(destination, file));
      }
    }
    const app = projectName ?? IOSConfig.XcodeUtils.getProjectName(root);
    await copyFile(path.join(root, 'targets', 'agent-activity', intentsFile),
      path.join(platformProjectRoot, app, intentsFile));
    return config;
  }]);
  return withXcodeProject(config, config => {
    const project = config.modResults;
    const app = config.modRequest.projectName ?? IOSConfig.XcodeUtils.getProjectName(config.modRequest.projectRoot);
    const target = IOSConfig.XcodeUtils.getApplicationNativeTarget({ project, projectName: app });
    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({ filepath: path.join(app, intentsFile), groupName: app, project, targetUuid: target.uuid });
    return config;
  });
};
