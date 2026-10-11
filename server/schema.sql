-- HOTELI POA Supabase setup. Run this once in the Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'customer'
    check (role in ('customer','waiter','cashier','supervisor','manager','admin')),
  created_at timestamptz not null default now()
);
alter table public.user_roles enable row level security;
revoke all on public.user_roles from anon, authenticated;

create or replace function public.pos_current_role()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select role from public.user_roles where user_id = auth.uid()), 'customer')
$$;
revoke all on function public.pos_current_role() from public;
grant execute on function public.pos_current_role() to authenticated;

create table if not exists public.app_records (
  collection_path text not null,
  id text not null,
  owner_id uuid references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (collection_path, id)
);
create index if not exists app_records_owner_idx on public.app_records(owner_id);
create index if not exists app_records_collection_idx on public.app_records(collection_path);
alter table public.app_records enable row level security;
grant select on public.app_records to anon;
grant select, insert, update, delete on public.app_records to authenticated;

drop policy if exists "read public catalog and permitted records" on public.app_records;
create policy "read public catalog and permitted records" on public.app_records
for select to anon, authenticated using (
  collection_path in ('categories','products')
  or owner_id = auth.uid()
  or (collection_path = 'orders' and public.pos_current_role() in ('waiter','cashier','supervisor','manager','admin'))
  or (collection_path in ('messages','typing') and public.pos_current_role() in ('waiter','cashier','supervisor','manager','admin'))
  or (collection_path = 'settings' and id = 'general')
);

drop policy if exists "create own records and staff messages" on public.app_records;
create policy "create own records and staff messages" on public.app_records
for insert to authenticated with check (
  owner_id = auth.uid()
  or (collection_path in ('messages','typing') and public.pos_current_role() in ('waiter','cashier','supervisor','manager','admin'))
);

drop policy if exists "update own records and manager data" on public.app_records;
create policy "update own records and manager data" on public.app_records
for update to authenticated using (
  owner_id = auth.uid()
  or (collection_path in ('products','categories','orders') and public.pos_current_role() in ('manager','admin'))
  or (collection_path = 'settings' and id = 'general' and public.pos_current_role() in ('manager','admin'))
) with check (
  owner_id = auth.uid()
  or (collection_path in ('products','categories','orders') and public.pos_current_role() in ('manager','admin'))
  or (collection_path = 'settings' and id = 'general' and public.pos_current_role() in ('manager','admin'))
);

drop policy if exists "delete own records and manager data" on public.app_records;
create policy "delete own records and manager data" on public.app_records
for delete to authenticated using (
  owner_id = auth.uid()
  or (collection_path in ('products','categories') and public.pos_current_role() in ('manager','admin'))
);

create table if not exists public.password_resets (
  email text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  code_hash text not null,
  code_salt text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.password_resets enable row level security;
revoke all on public.password_resets from anon, authenticated;
create index if not exists password_resets_expires_idx on public.password_resets(expires_at);

-- App-managed files use private buckets; the API returns short-lived signed URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hotel-media', 'hotel-media', false, 5242880, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do nothing;

drop policy if exists "users upload own images" on storage.objects;
create policy "users upload own images" on storage.objects for insert to authenticated
with check (bucket_id = 'hotel-media' and (
  (storage.foldername(name))[1] = auth.uid()::text
  or ((storage.foldername(name))[1] = 'products'
    and (storage.foldername(name))[2] = auth.uid()::text
    and public.pos_current_role() in ('manager','admin'))
));
drop policy if exists "users read own images and staff read product images" on storage.objects;
create policy "users read own images and staff read product images" on storage.objects for select to authenticated
using (bucket_id = 'hotel-media' and (
  (storage.foldername(name))[1] = auth.uid()::text
  or ((storage.foldername(name))[1] = 'products'
    and (storage.foldername(name))[2] = auth.uid()::text
    and public.pos_current_role() in ('manager','admin'))
));

-- Turn on Realtime for the generic POS records table.
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'app_records'
  ) then
    alter publication supabase_realtime add table public.app_records;
  end if;
end $$;

-- New users always start as customers. Promote staff explicitly after signup:
-- update public.user_roles set role='manager' where user_id='<auth.users UUID>';
create or replace function public.pos_create_default_role()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.user_roles(user_id, role) values(new.id, 'customer') on conflict (user_id) do nothing;
  return new;
end
$$;
drop trigger if exists pos_new_user_role on auth.users;
create trigger pos_new_user_role after insert on auth.users
for each row execute procedure public.pos_create_default_role();
