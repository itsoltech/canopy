package app.canopy.fileintake

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IntakeSourceTest {
  private val local = setOf("test.canopy.primary", "test.canopy.alias")

  @Test fun onlyExternalContentMayUseAReadGrant() {
    val unexpected = { error("Invalid intake source reached the permission check") }
    assertFalse(grantedExternalContent("file", null, local, unexpected))
    assertFalse(grantedExternalContent("content", "", local, unexpected))
    assertFalse(grantedExternalContent("content", "test.canopy.primary", local, unexpected))
    assertFalse(grantedExternalContent("content", "10@test.canopy.alias", local, unexpected))
    assertFalse(grantedExternalContent("content", "10@0@test.example", local, unexpected))
  }

  @Test fun grantedDocumentsIncludeExternalWorkProfiles() {
    assertFalse(grantedExternalContent("content", "test.documents", local) { false })
    assertTrue(grantedExternalContent("content", "test.documents", local) { true })
    assertTrue(grantedExternalContent("content", "10@test.documents", local) { true })
  }
}
