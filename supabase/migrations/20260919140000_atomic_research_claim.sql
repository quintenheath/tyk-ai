create or replace function public.claim_next_research_task()
returns setof public.research_queue
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id uuid;
begin
  select id into claimed_id
  from public.research_queue
  where status in ('queued', 'reverify', 'failed')
    and attempts < 3
    and (next_research_date is null or next_research_date <= now())
  order by manually_prioritized desc nulls last, priority desc, updated_at asc
  for update skip locked
  limit 1;

  if claimed_id is null then
    return;
  end if;

  update public.research_queue
  set status = 'researching',
      last_attempted_at = now(),
      progress_percent = case when progress_percent > 0 then progress_percent else 0 end,
      progress_stage = case when progress_stage is null then 'Initializing research' else progress_stage end,
      updated_at = now()
  where id = claimed_id;

  return query select * from public.research_queue where id = claimed_id;
end;
$$;
