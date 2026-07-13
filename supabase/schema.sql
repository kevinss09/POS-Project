-- BingPpang POS Supabase schema
-- Run this entire file in Supabase Dashboard > SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.app_settings (
  id integer primary key default 1 check (id = 1),
  business_name text not null default 'BingPpang',
  tax_enabled boolean not null default false,
  tax_rate numeric(6,3) not null default 5,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (id, business_name, tax_enabled, tax_rate)
values (1, 'BingPpang', false, 5)
on conflict (id) do nothing;

create table if not exists public.menu_items (
  id text primary key,
  category text not null check (category in ('Bungeoppang', 'Bingsu')),
  name text not null,
  price numeric(10,2) not null check (price >= 0),
  sold_out boolean not null default false,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.menu_items (id, category, name, price, sold_out, sort_order) values
('b-custard','Bungeoppang','Custard',3.50,false,10),
('b-nutella','Bungeoppang','Nutella',3.50,false,20),
('b-banana-choco','Bungeoppang','Banana Chocolate',3.50,false,30),
('b-strawberry-cream','Bungeoppang','Strawberry Cream',3.50,false,40),
('b-matcha-cream','Bungeoppang','Matcha Cream',3.50,false,50),
('b-mango','Bungeoppang','Mango',3.50,false,60),
('b-dubai','Bungeoppang','Dubai Chocolate',4.00,false,70),
('b-bburinkle','Bungeoppang','Bburinkle Cheese',4.00,false,80),
('s-oreo','Bingsu','Oreo',12.50,false,110),
('s-matcha','Bingsu','Matcha',12.50,false,120),
('s-strawberry','Bingsu','Strawberry',14.00,false,130),
('s-mango','Bingsu','Mango',14.00,false,140),
('s-dubai','Bingsu','Dubai Chocolate',14.00,false,150)
on conflict (id) do nothing;

create sequence if not exists public.order_number_seq start 1;

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number bigint not null unique default nextval('public.order_number_seq'),
  note text not null default '',
  subtotal numeric(10,2) not null,
  tax_rate numeric(6,3) not null default 0,
  tax numeric(10,2) not null default 0,
  total numeric(10,2) not null,
  payment_method text not null check (payment_method in ('cash', 'card')),
  cash_received numeric(10,2),
  status text not null default 'preparing' check (status in ('preparing', 'completed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.order_items (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  menu_item_id text not null,
  name text not null,
  category text not null,
  unit_price numeric(10,2) not null,
  quantity integer not null check (quantity > 0),
  line_total numeric(10,2) not null
);

create index if not exists idx_orders_status_created on public.orders(status, created_at);
create index if not exists idx_order_items_order on public.order_items(order_id);

create or replace function public.create_pos_order(
  p_items jsonb,
  p_note text,
  p_payment_method text,
  p_cash_received numeric default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_subtotal numeric(10,2) := 0;
  v_tax_rate numeric(6,3) := 0;
  v_tax numeric(10,2) := 0;
  v_total numeric(10,2) := 0;
  v_item jsonb;
  v_menu public.menu_items%rowtype;
  v_qty integer;
begin
  if p_payment_method not in ('cash', 'card') then
    raise exception 'Invalid payment method';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Order must contain at least one item';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_menu
    from public.menu_items
    where id = v_item->>'menu_item_id';

    if not found or v_menu.sold_out then
      raise exception 'Menu item is unavailable: %', v_item->>'menu_item_id';
    end if;

    v_qty := greatest(1, coalesce((v_item->>'quantity')::integer, 1));
    v_subtotal := v_subtotal + (v_menu.price * v_qty);
  end loop;

  select case when tax_enabled then tax_rate else 0 end
  into v_tax_rate
  from public.app_settings where id = 1;

  v_tax := round(v_subtotal * v_tax_rate / 100, 2);
  v_total := round(v_subtotal + v_tax, 2);

  if p_payment_method = 'cash' and coalesce(p_cash_received, 0) < v_total then
    raise exception 'Cash received is less than the order total';
  end if;

  insert into public.orders (
    note, subtotal, tax_rate, tax, total, payment_method, cash_received, status
  ) values (
    coalesce(trim(p_note), ''), round(v_subtotal, 2), v_tax_rate, v_tax, v_total,
    p_payment_method, p_cash_received, 'preparing'
  ) returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_menu from public.menu_items where id = v_item->>'menu_item_id';
    v_qty := greatest(1, coalesce((v_item->>'quantity')::integer, 1));

    insert into public.order_items (
      order_id, menu_item_id, name, category, unit_price, quantity, line_total
    ) values (
      v_order_id, v_menu.id, v_menu.name, v_menu.category, v_menu.price,
      v_qty, round(v_menu.price * v_qty, 2)
    );
  end loop;

  return v_order_id;
end;
$$;

create or replace function public.complete_pos_order(p_order_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.orders
  set status = 'completed', completed_at = now()
  where id = p_order_id;
$$;

create or replace function public.reopen_pos_order(p_order_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.orders
  set status = 'preparing', completed_at = null
  where id = p_order_id;
$$;

create or replace function public.clear_pos_history(p_confirmation text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_confirmation <> 'RESET' then
    raise exception 'Confirmation text must be RESET';
  end if;

  delete from public.orders;
  alter sequence public.order_number_seq restart with 1;
end;
$$;

create or replace function public.reset_pos_order_numbers()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.orders) then
    perform setval('public.order_number_seq',
      greatest((select coalesce(max(order_number), 0) + 1 from public.orders), 1),
      false
    );
  else
    alter sequence public.order_number_seq restart with 1;
  end if;
end;
$$;

alter table public.app_settings enable row level security;
alter table public.menu_items enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

-- Booth prototype policies. Anyone with the public project key can use the POS.
-- Before public production, add Supabase Auth and role-based policies.
drop policy if exists "public read settings" on public.app_settings;
create policy "public read settings" on public.app_settings for select to anon, authenticated using (true);
drop policy if exists "public update settings" on public.app_settings;
create policy "public update settings" on public.app_settings for update to anon, authenticated using (true) with check (true);

drop policy if exists "public read menu" on public.menu_items;
create policy "public read menu" on public.menu_items for select to anon, authenticated using (true);
drop policy if exists "public update menu" on public.menu_items;
create policy "public update menu" on public.menu_items for update to anon, authenticated using (true) with check (true);

drop policy if exists "public read orders" on public.orders;
create policy "public read orders" on public.orders for select to anon, authenticated using (true);
drop policy if exists "public read order items" on public.order_items;
create policy "public read order items" on public.order_items for select to anon, authenticated using (true);

grant usage on schema public to anon, authenticated;
grant select, update on public.app_settings to anon, authenticated;
grant select, update on public.menu_items to anon, authenticated;
grant select on public.orders, public.order_items to anon, authenticated;
grant execute on function public.create_pos_order(jsonb, text, text, numeric) to anon, authenticated;
grant execute on function public.complete_pos_order(uuid) to anon, authenticated;
grant execute on function public.reopen_pos_order(uuid) to anon, authenticated;
grant execute on function public.clear_pos_history(text) to anon, authenticated;
grant execute on function public.reset_pos_order_numbers() to anon, authenticated;

-- Add tables to the Realtime publication.
do $$
begin
  begin alter publication supabase_realtime add table public.orders; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.order_items; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.menu_items; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.app_settings; exception when duplicate_object then null; end;
end $$;
