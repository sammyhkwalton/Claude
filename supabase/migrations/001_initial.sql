-- Enable UUID extension
create extension if not exists "pgcrypto";

-- SOWs table
create table sows (
  id              text primary key,
  customer        text not null,
  region          text default '',
  products        text[] default '{}',
  status          text not null default 'draft',
  locked          boolean not null default false,
  data            jsonb not null default '{"fields":{},"lists":{}}'::jsonb,
  customer_token  uuid not null default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      text default '',
  progress_you    int not null default 0,
  progress_ingrid int not null default 0
);

-- Allow anon key full access (auth is handled client-side via password)
alter table sows enable row level security;

create policy anon_all on sows for all to anon using (true) with check (true);

-- Auto-update updated_at
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger sows_updated_at before update on sows
  for each row execute function set_updated_at();

-- RPC: customer reads a single SOW by id + token
create or replace function get_sow_for_customer(p_id text, p_token uuid)
returns table(id text, customer text, status text, locked boolean, data jsonb, updated_at timestamptz, progress_you int, progress_ingrid int)
language sql security definer set search_path = public as $$
  select id, customer, status, locked, data, updated_at, progress_you, progress_ingrid
  from sows
  where sows.id = p_id and sows.customer_token = p_token;
$$;

-- Ingrid-owned field keys (preserved when customer writes)
-- Corresponds to data-owner="ingrid" sections in the HTML
-- Fields: tier-checkout, tier-tracking, prod-checkout, prod-tracking, prod-returns,
--         prod-transport, prod-instore, partner-loqate, special-considerations,
--         ms-start, ms-integration, ms-testing, ms-golive,
--         ing-impl, ing-integration, ing-csm
-- Lists:  integrations, devreq

create or replace function customer_patch_sow(
  p_id text,
  p_token uuid,
  p_data jsonb,
  p_progress_you int default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  existing sows%rowtype;
  ingrid_field_keys text[] := array[
    'tier-checkout','tier-tracking','prod-checkout','prod-tracking',
    'prod-returns','prod-transport','prod-instore','partner-loqate',
    'special-considerations','ms-start','ms-integration','ms-testing',
    'ms-golive','ing-impl','ing-integration','ing-csm'
  ];
  ingrid_list_keys text[] := array['integrations','devreq'];
  merged_fields jsonb;
  merged_lists jsonb;
  new_fields jsonb;
  new_lists jsonb;
  k text;
begin
  select * into existing from sows where id = p_id and customer_token = p_token;
  if not found then raise exception 'not_found'; end if;
  if existing.locked then raise exception 'locked'; end if;

  new_fields := coalesce(p_data->'fields', '{}'::jsonb);
  new_lists  := coalesce(p_data->'lists',  '{}'::jsonb);

  merged_fields := new_fields;
  foreach k in array ingrid_field_keys loop
    if existing.data->'fields' ? k then
      merged_fields := jsonb_set(merged_fields, array[k], (existing.data->'fields')->k);
    else
      merged_fields := merged_fields - k;
    end if;
  end loop;

  merged_lists := new_lists;
  foreach k in array ingrid_list_keys loop
    if existing.data->'lists' ? k then
      merged_lists := jsonb_set(merged_lists, array[k], (existing.data->'lists')->k);
    else
      merged_lists := merged_lists - k;
    end if;
  end loop;

  update sows set
    data = jsonb_build_object('fields', merged_fields, 'lists', merged_lists),
    updated_at = now(),
    updated_by = 'customer',
    progress_you = coalesce(p_progress_you, progress_you)
  where id = p_id and customer_token = p_token;

  return jsonb_build_object('fields', merged_fields, 'lists', merged_lists);
end;
$$;
