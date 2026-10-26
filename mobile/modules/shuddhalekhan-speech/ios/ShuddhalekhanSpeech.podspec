Pod::Spec.new do |s|
  s.name = 'ShuddhalekhanSpeech'
  s.version = '0.1.0'
  s.summary = 'On-device Parakeet transcription for Shuddhalekhan'
  s.homepage = 'https://github.com/PeeeBrain/shuddhalekhan'
  s.license = 'MIT'
  s.author = 'Shuddhalekhan'
  s.source = { :path => '.' }
  s.source_files = '**/*.swift'
  s.ios.deployment_target = '17.0'
  s.swift_version = '6.0'
  s.dependency 'ExpoModulesCore'
  s.dependency 'FluidAudio'
end
