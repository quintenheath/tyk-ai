alter table public.documents
  add column if not exists document_scope text not null default 'COMPANY',
  add column if not exists audit_id uuid references public.hardware_audits(id) on delete set null,
  add column if not exists conversation_id uuid references public.conversations(id) on delete set null;

alter table public.document_chunks
  add column if not exists document_scope text not null default 'COMPANY',
  add column if not exists audit_id uuid references public.hardware_audits(id) on delete set null,
  add column if not exists conversation_id uuid references public.conversations(id) on delete set null;

create index if not exists idx_documents_scope_audit
  on public.documents (document_scope, audit_id, conversation_id);
create index if not exists idx_document_chunks_scope_audit
  on public.document_chunks (document_scope, audit_id, conversation_id);

update public.documents d
set document_scope = 'AUDIT_ONLY',
    audit_id = a.id,
    conversation_id = a.conversation_id
from public.hardware_audits a
where a.document_id = d.id;

update public.document_chunks dc
set document_scope = 'AUDIT_ONLY',
    audit_id = a.id,
    conversation_id = a.conversation_id
from public.hardware_audits a
where a.document_id = dc.document_id;

create or replace function public.match_document_chunks(
  query_embedding extensions.vector,
  match_count integer default 6,
  filter_document_ids uuid[] default null,
  include_audit_documents boolean default false,
  filter_audit_id uuid default null,
  filter_conversation_id uuid default null
)
returns table(
  id uuid,
  document_id uuid,
  content text,
  page_number integer,
  chunk_index integer,
  metadata jsonb,
  similarity double precision
)
language sql stable
as $$
  select dc.id, dc.document_id, dc.content, dc.page_number, dc.chunk_index,
    dc.metadata, 1 - (dc.embedding OPERATOR(extensions.<=>) query_embedding) as similarity
  from public.document_chunks dc
  where dc.embedding is not null
    and (filter_document_ids is null or dc.document_id = any(filter_document_ids))
    and (
      (include_audit_documents = false and coalesce(dc.document_scope, 'COMPANY') <> 'AUDIT_ONLY')
      or (
        include_audit_documents = true
        and coalesce(dc.document_scope, 'COMPANY') = 'AUDIT_ONLY'
        and (filter_audit_id is null or dc.audit_id = filter_audit_id)
        and (filter_conversation_id is null or dc.conversation_id = filter_conversation_id)
      )
    )
  order by dc.embedding OPERATOR(extensions.<=>) query_embedding
  limit match_count;
$$;