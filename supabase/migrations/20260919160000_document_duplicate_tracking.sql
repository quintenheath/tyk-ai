alter table public.documents
  add column if not exists duplicate_of uuid references public.documents(id) on delete set null;

create index if not exists idx_documents_duplicate_of
  on public.documents (duplicate_of);