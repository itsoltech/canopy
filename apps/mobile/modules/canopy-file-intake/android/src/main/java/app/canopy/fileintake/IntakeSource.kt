package app.canopy.fileintake

/** ContentResolver accepts several schemes. Intake requires a granted URI belonging to another app. */
internal fun grantedExternalContent(
  scheme: String?,
  authority: String?,
  localAuthorities: Set<String>,
  hasReadGrant: () -> Boolean
): Boolean {
  if (scheme != "content" || authority.isNullOrEmpty()) return false
  // Android may prefix the provider authority with a numeric user/profile id.
  val provider = authority.substringAfter('@')
  if (provider.isEmpty() || '@' in provider) return false
  if ('@' in authority && authority.substringBefore('@').toIntOrNull() == null) return false
  if (localAuthorities.any { it.equals(provider, ignoreCase = true) }) return false
  return hasReadGrant()
}
