alter table public.web_sources
  add column if not exists knowledge_state text not null default 'SOURCE_BACKED';

create table if not exists public.web_source_conflicts (
  id uuid primary key default gen_random_uuid(),
  entity_name text,
  topic text,
  source_a_url text,
  source_b_url text,
  source_a_claim text,
  source_b_claim text,
  status text not null default 'NEEDS_REVIEW',
  discovered_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution text
);

alter table public.web_source_conflicts enable row level security;
create index if not exists idx_web_source_conflicts_status
  on public.web_source_conflicts (status, discovered_at desc);
