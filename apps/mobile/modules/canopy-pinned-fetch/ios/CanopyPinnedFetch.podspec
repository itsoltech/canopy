Pod::Spec.new do |s|
  s.name           = 'CanopyPinnedFetch'
  s.version        = '1.0.0'
  s.summary        = 'HTTPS requests trusted only through a pinned certificate fingerprint'
  s.description    = 'Canopy phones reach their computer over network access: the computer certificate is pinned, system trust and host names are not used.'
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
