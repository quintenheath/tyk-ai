create table if not exists public.hardware_audits (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  project_name text,
  status text not null default 'analyzing',
  openings_count integer not null default 0,
  hardware_sets_count integer not null default 0,
  issues_count integer not null default 0,
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.hardware_audit_findings (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null references public.hardware_audits(id) on delete cascade,
  severity text not null default 'INFO',
  category text not null,
  status text not null default 'NEEDS_REVIEW',
  title text not null,
  description text not null,
  recommendation text,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

alter table public.hardware_audits enable row level security;
alter table public.hardware_audit_findings enable row level security;
create index if not exists idx_hardware_audits_created_at on public.hardware_audits (created_at desc);
create index if not exists idx_hardware_audit_findings_audit_id on public.hardware_audit_findings (audit_id, severity);
