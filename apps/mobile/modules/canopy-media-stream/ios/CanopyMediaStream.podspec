Pod::Spec.new do |s|
  s.name = 'CanopyMediaStream'
  s.version = '1.0.0'
  s.summary = 'Private loopback media reads through the paired authenticated transport'
  s.license = 'UNLICENSED'
  s.author = 'Canopy'
  s.homepage = 'https://github.com/itsoltech/canopy'
  s.platforms = { :ios => '16.4' }
  s.source = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
end
