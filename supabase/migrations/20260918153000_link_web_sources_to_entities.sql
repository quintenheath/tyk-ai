alter table public.web_sources
  add column if not exists entity_id uuid references public.knowledge_entities(id) on delete set null;

create index if not exists idx_web_sources_entity_id
  on public.web_sources (entity_id);
