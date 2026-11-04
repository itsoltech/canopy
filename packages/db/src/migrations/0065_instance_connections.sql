-- The built-in instance keeps its identity while its connection can change.
ALTER TABLE provider_instances DROP CONSTRAINT provider_instances_built_in;
ALTER TABLE provider_instances ADD CONSTRAINT provider_instances_built_in
  CHECK (NOT built_in OR id = 'native');
