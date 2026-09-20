update public.document_chunks dc
set document_scope = 'AUDIT_ONLY',
    audit_id = d.audit_id,
    conversation_id = d.conversation_id
from public.documents d
where d.id = dc.document_id
  and d.document_scope = 'AUDIT_ONLY';

update public.conversations c
set active_audit = a.id,
    active_document = a.document_id
from public.hardware_audits a
where a.conversation_id = c.id;