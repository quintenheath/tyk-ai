alter table public.research_queue
  add column if not exists progress_percent integer not null default 0,
  add column if not exists progress_stage text,
  add column if not exists manually_prioritized boolean not null default false,
  add column if not exists prioritized_at timestamptz,
  add column if not exists prioritized_by text;

create index if not exists idx_research_queue_manual_priority
  on public.research_queue (manually_prioritized, status, updated_at);
