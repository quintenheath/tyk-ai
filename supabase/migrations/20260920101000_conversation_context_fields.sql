alter table public.conversations
  add column if not exists active_entity text,
  add column if not exists active_project text,
  add column if not exists active_document uuid references public.documents(id) on delete set null,
  add column if not exists active_audit uuid references public.hardware_audits(id) on delete set null,
  add column if not exists active_opening text,
  add column if not exists active_hardware_item text,
  add column if not exists active_finding uuid references public.hardware_audit_findings(id) on delete set null,
  add column if not exists active_source text,
  add column if not exists active_subtopic text,
  add column if not exists recent_entities jsonb not null default '[]'::jsonb,
  add column if not exists recent_references jsonb not null default '[]'::jsonb,
  add column if not exists recent_user_intent text;