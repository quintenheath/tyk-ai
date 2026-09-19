alter table public.research_queue
  add column if not exists research_depth integer not null default 0,
  add column if not exists research_attempts integer not null default 0,
  add column if not exists sources_checked integer not null default 0,
  add column if not exists authoritative_sources_found integer not null default 0,
  add column if not exists follow_up_tasks_created integer not null default 0,
  add column if not exists knowledge_records_created integer not null default 0,
  add column if not exists completeness_state text not null default 'DISCOVERED',
  add column if not exists next_research_at timestamptz;

create index if not exists idx_research_queue_completeness
  on public.research_queue (completeness_state, next_research_at, priority desc);
