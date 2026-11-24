ALTER TABLE memory_reflection_settings
  DROP CONSTRAINT memory_reflection_settings_interval_minutes_check,
  ADD CONSTRAINT memory_reflection_settings_interval_minutes_check
    CHECK (interval_minutes IN (60,360,720,1440,4320,10080));
