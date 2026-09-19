alter table public.documents
  add column if not exists document_family_id uuid references public.documents(id) on delete set null,
  add column if not exists version_label text,
  add column if not exists publication_date text,
  add column if not exists effective_date text,
  add column if not exists content_hash text,
  add column if not exists verification_status text not null default 'UNKNOWN',
  add column if not exists last_verified_at timestamptz,
  add column if not exists next_verification_at timestamptz,
  add column if not exists verification_error text;

create index if not exists idx_documents_verification
  on public.documents (verification_status, next_verification_at);
create index if not exists idx_documents_family
  on public.documents (document_family_id, created_at desc);
create unique index if not exists idx_documents_content_hash
  on public.documents (content_hash)
  where content_hash is not null;
