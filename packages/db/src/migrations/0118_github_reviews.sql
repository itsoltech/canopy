ALTER TABLE github_mutation_receipts ADD COLUMN parameters jsonb NOT NULL DEFAULT '{}';
