-- Rendo M3.7 fix for 0010: the 3-questions / 10-answers limits blocked "insert ... on conflict do update".
--
-- Found by re-running the demo seed on a database where it had already run: Postgres fires BEFORE INSERT
-- triggers before it detects the conflict, so re-saving an EXISTING question ("Taille") of a style that
-- already has 3 questions was counted as a 4th one and refused. The same would hit the owner's catalogue
-- editing later (M5). A row with the same name is the same question/answer (unique (service_id, name) /
-- unique (group_id, name)), so it is no longer counted.

create or replace function public.rendo_check_choice_group_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- lock the style so two inserts at the same time can't both pass the count
  perform 1 from public.services s where s.id = new.service_id for update;
  if (select count(*) from public.service_choice_groups g
       where g.service_id = new.service_id and g.id <> new.id and g.name <> new.name) >= 3 then
    raise exception 'a style can have at most 3 questions (service %)', new.service_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace function public.rendo_check_choice_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not new.active then
    return new;
  end if;
  perform 1 from public.service_choice_groups g where g.id = new.group_id for update;
  if (select count(*) from public.service_choices c
       where c.group_id = new.group_id and c.active and c.id <> new.id and c.name <> new.name) >= 10 then
    raise exception 'a question can have at most 10 active answers (group %)', new.group_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.rendo_check_choice_group_limit(), public.rendo_check_choice_limit()
  from public, anon, authenticated;
