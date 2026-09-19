alter table public.conversations
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by text,
  add column if not exists deletion_reason text,
  add column if not exists restored_at timestamptz,
  add column if not exists restored_by text;

create index if not exists idx_conversations_deleted_at
  on public.conversations (deleted_at, updated_at desc);