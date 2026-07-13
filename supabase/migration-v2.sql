-- BingPpang POS v2 migration
-- Run this ONCE in Supabase Dashboard > SQL Editor.

alter table public.orders
  add column if not exists bundle_discount numeric(10,2) not null default 0,
  add column if not exists bungeoppang_required boolean not null default false,
  add column if not exists bingsu_required boolean not null default false,
  add column if not exists bungeoppang_completed boolean not null default false,
  add column if not exists bingsu_completed boolean not null default false,
  add column if not exists canceled_at timestamptz;

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders
  add constraint orders_status_check check (status in ('preparing', 'completed', 'canceled'));

-- Update existing orders so they continue to display correctly.
update public.orders o
set
  bungeoppang_required = exists (
    select 1 from public.order_items i
    where i.order_id = o.id and i.category = 'Bungeoppang'
  ),
  bingsu_required = exists (
    select 1 from public.order_items i
    where i.order_id = o.id and i.category = 'Bingsu'
  ),
  bungeoppang_completed = case when o.status = 'completed' then true else false end,
  bingsu_completed = case when o.status = 'completed' then true else false end;

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
  v_raw_subtotal numeric(10,2) := 0;
  v_subtotal numeric(10,2) := 0;
  v_bundle_discount numeric(10,2) := 0;
  v_tax_rate numeric(6,3) := 0;
  v_tax numeric(10,2) := 0;
  v_total numeric(10,2) := 0;
  v_item jsonb;
  v_menu public.menu_items%rowtype;
  v_qty integer;
  v_bungeoppang_qty integer := 0;
  v_has_bungeoppang boolean := false;
  v_has_bingsu boolean := false;
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
    v_raw_subtotal := v_raw_subtotal + (v_menu.price * v_qty);

    if v_menu.category = 'Bungeoppang' then
      v_bungeoppang_qty := v_bungeoppang_qty + v_qty;
      v_has_bungeoppang := true;
    elsif v_menu.category = 'Bingsu' then
      v_has_bingsu := true;
    end if;
  end loop;

  -- Every complete group of 5 Bungeoppang receives a $2.50 discount:
  -- 5 regular pieces ($17.50) become $15.00. Premium items keep their $0.50 surcharge.
  v_bundle_discount := floor(v_bungeoppang_qty / 5.0) * 2.50;
  v_subtotal := round(v_raw_subtotal - v_bundle_discount, 2);

  select case when tax_enabled then tax_rate else 0 end
  into v_tax_rate
  from public.app_settings where id = 1;

  v_tax := round(v_subtotal * v_tax_rate / 100, 2);
  v_total := round(v_subtotal + v_tax, 2);

  if p_payment_method = 'cash' and coalesce(p_cash_received, 0) < v_total then
    raise exception 'Cash received is less than the order total';
  end if;

  insert into public.orders (
    note, subtotal, bundle_discount, tax_rate, tax, total,
    payment_method, cash_received, status,
    bungeoppang_required, bingsu_required,
    bungeoppang_completed, bingsu_completed
  ) values (
    coalesce(trim(p_note), ''), v_subtotal, v_bundle_discount, v_tax_rate, v_tax, v_total,
    p_payment_method, p_cash_received, 'preparing',
    v_has_bungeoppang, v_has_bingsu,
    false, false
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

create or replace function public.complete_pos_station(
  p_order_id uuid,
  p_station text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_station not in ('Bungeoppang', 'Bingsu') then
    raise exception 'Invalid preparation station';
  end if;

  if p_station = 'Bungeoppang' then
    update public.orders
    set bungeoppang_completed = true
    where id = p_order_id and status = 'preparing' and bungeoppang_required;
  else
    update public.orders
    set bingsu_completed = true
    where id = p_order_id and status = 'preparing' and bingsu_required;
  end if;

  update public.orders
  set status = 'completed', completed_at = now()
  where id = p_order_id
    and status = 'preparing'
    and (not bungeoppang_required or bungeoppang_completed)
    and (not bingsu_required or bingsu_completed);
end;
$$;

create or replace function public.reopen_pos_station(
  p_order_id uuid,
  p_station text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_station not in ('Bungeoppang', 'Bingsu') then
    raise exception 'Invalid preparation station';
  end if;

  if p_station = 'Bungeoppang' then
    update public.orders
    set bungeoppang_completed = false,
        status = 'preparing',
        completed_at = null
    where id = p_order_id and status <> 'canceled';
  else
    update public.orders
    set bingsu_completed = false,
        status = 'preparing',
        completed_at = null
    where id = p_order_id and status <> 'canceled';
  end if;
end;
$$;

create or replace function public.cancel_pos_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.orders
  set status = 'canceled',
      canceled_at = now(),
      completed_at = null
  where id = p_order_id and status = 'preparing';
end;
$$;

grant execute on function public.complete_pos_station(uuid, text) to anon, authenticated;
grant execute on function public.reopen_pos_station(uuid, text) to anon, authenticated;
grant execute on function public.cancel_pos_order(uuid) to anon, authenticated;

-- Keep the clear-history function compatible with Supabase safe-update protection.
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

  delete from public.orders where id is not null;
  alter sequence public.order_number_seq restart with 1;
end;
$$;
