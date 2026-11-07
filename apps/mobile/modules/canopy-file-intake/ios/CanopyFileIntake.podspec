Pod::Spec.new do |s|
  s.name           = 'CanopyFileIntake'
  s.version        = '1.0.0'
  s.summary        = 'Files pasted into the composer or dropped on a thread'
  s.description    = 'Native paste of images and files into the composer text and drops from other apps, copied into the app cache for the attachment upload.'
  s.license        = 'UNLICENSED'
  s.author         = 'Canopy'
  s.homepage       = 'https://github.com/canopy'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
