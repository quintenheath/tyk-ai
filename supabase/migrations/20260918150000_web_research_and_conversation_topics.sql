alter table public.conversations
  add column if not exists topic_summary text;

create table if not exists public.web_sources (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  title text,
  domain text,
  retrieved_at timestamptz not null default now(),
  snippet text,
  topic text,
  entity_name text,
  answer text,
  confidence text,
  source_type text not null default 'web_search',
  provider text not null default 'gemini_google_search',
  conversation_id uuid references public.conversations(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_web_sources_url_topic
  on public.web_sources (url, topic);
create index if not exists idx_web_sources_topic
  on public.web_sources using gin (to_tsvector('simple', coalesce(topic, '') || ' ' || coalesce(title, '') || ' ' || coalesce(snippet, '') || ' ' || coalesce(answer, '')));
create index if not exists idx_web_sources_entity_name
  on public.web_sources (entity_name);

alter table public.web_sources enable row level security;
