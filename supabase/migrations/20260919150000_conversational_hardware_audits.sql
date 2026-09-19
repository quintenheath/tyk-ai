alter table public.hardware_audits
  add column if not exists conversation_id uuid references public.conversations(id) on delete set null,
  add column if not exists user_id uuid references public.app_users(id) on delete cascade,
  add column if not exists session_id uuid references public.temp_sessions(id) on delete cascade;

create index if not exists idx_hardware_audits_conversation_id
  on public.hardware_audits (conversation_id);