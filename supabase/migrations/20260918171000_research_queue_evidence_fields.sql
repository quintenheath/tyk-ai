alter table public.research_queue
  add column if not exists manufacturer text,
  add column if not exists supplier text,
  add column if not exists search_queries jsonb not null default '[]'::jsonb,
  add column if not exists discovered_knowledge jsonb not null default '{}'::jsonb,
  add column if not exists confidence text,
  add column if not exists retry_count integer not null default 0,
  add column if not exists last_attempted_at timestamptz,
  add column if not exists next_attempt_at timestamptz;

create index if not exists idx_research_queue_next_attempt
  on public.research_queue (status, priority desc, next_attempt_at, updated_at);
