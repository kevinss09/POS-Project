-- BingPpang POS v3: Send Off workflow
-- Run this ONCE after migration-v2.sql.

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders
  add constraint orders_status_check
  check (status in ('preparing', 'ready', 'completed', 'canceled'));

-- Kitchen stations now mark their portion READY.
-- The order becomes overall READY only when every required station is ready.
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
    where id = p_order_id
      and status in ('preparing', 'ready')
      and bungeoppang_required;
  else
    update public.orders
    set bingsu_completed = true
    where id = p_order_id
      and status in ('preparing', 'ready')
      and bingsu_required;
  end if;

  update public.orders
  set status = case
    when (not bungeoppang_required or bungeoppang_completed)
     and (not bingsu_required or bingsu_completed)
      then 'ready'
    else 'preparing'
  end,
  completed_at = null
  where id = p_order_id
    and status <> 'canceled';
end;
$$;

-- Undo a station-ready action.
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

-- Only Send Off completes the customer order.
create or replace function public.finish_pos_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.orders
  set status = 'completed',
      completed_at = now()
  where id = p_order_id
    and status = 'ready'
    and (not bungeoppang_required or bungeoppang_completed)
    and (not bingsu_required or bingsu_completed);

  if not found then
    raise exception 'Order is not ready to finish';
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
  where id = p_order_id and status in ('preparing', 'ready');
end;
$$;

grant execute on function public.finish_pos_order(uuid) to anon, authenticated;
