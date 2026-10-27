Pod::Spec.new do |s|
  s.name = 'ShuddhalekhanAgentActivity'
  s.version = '0.1.0'
  s.summary = 'Agent run Live Activities and foreground-started background work'
  s.homepage = 'https://github.com/PeeeBrain/shuddhalekhan'
  s.license = 'MIT'
  s.author = 'Shuddhalekhan'
  s.source = { :path => '.' }
  s.source_files = '**/*.swift'
  s.ios.deployment_target = '17.0'
  s.swift_version = '6.0'
  s.frameworks = 'ActivityKit', 'BackgroundTasks', 'UIKit', 'UserNotifications'
  s.dependency 'ExpoModulesCore'
end
