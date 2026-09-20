alter table public.documents
  add column if not exists processing_started_at timestamptz,
  add column if not exists processing_updated_at timestamptz,
  add column if not exists heartbeat_at timestamptz,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists worker_id text,
  add column if not exists classification_confidence text,
  add column if not exists classification_source text,
  add column if not exists document_subtype text,
  add column if not exists language text;

create index if not exists idx_documents_processing_recovery
  on public.documents (status, heartbeat_at, updated_at);