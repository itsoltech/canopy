Pod::Spec.new do |s|
  s.name           = 'CanopyPushPreview'
  s.version        = '1.0.0'
  s.summary        = 'Device-only keys for encrypted notification previews'
  s.license        = 'UNLICENSED'
  s.author         = 'Canopy'
  s.homepage       = 'https://github.com/canopy'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = 'CanopyPushPreviewModule.swift', 'PushDismissalAppDelegate.swift', 'Shared/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
