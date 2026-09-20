create table if not exists public.hardware_audit_fire_checks (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null unique references public.hardware_audits(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  status text not null default 'NOT_STARTED',
  started_at timestamptz,
  completed_at timestamptz,
  findings_count integer not null default 0,
  evidence jsonb not null default '{}'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  code_sections jsonb not null default '[]'::jsonb,
  manufacturer_requirements jsonb not null default '[]'::jsonb,
  affected_openings jsonb not null default '[]'::jsonb,
  error_message text
);

create table if not exists public.hardware_audit_changes (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null references public.hardware_audits(id) on delete cascade,
  finding_id uuid references public.hardware_audit_findings(id) on delete set null,
  document_id uuid not null references public.documents(id) on delete cascade,
  opening text,
  hardware_set text,
  hardware_item text,
  page integer,
  original_value text,
  proposed_value text,
  reason text not null,
  evidence jsonb not null default '{}'::jsonb,
  source jsonb not null default '{}'::jsonb,
  decision text not null default 'PENDING',
  decided_by uuid references public.app_users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_hardware_audit_changes_audit on public.hardware_audit_changes(audit_id, decision);