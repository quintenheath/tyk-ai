alter table public.web_sources
  add column if not exists search_query text,
  add column if not exists evidence_text text,
  add column if not exists extracted_facts jsonb not null default '[]'::jsonb,
  add column if not exists authoritative boolean not null default false,
  add column if not exists source_date timestamptz,
  add column if not exists document_name text,
  add column if not exists document_page integer,
  add column if not exists document_chunk text;

create index if not exists idx_web_sources_authoritative
  on public.web_sources (authoritative, retrieved_at desc);

