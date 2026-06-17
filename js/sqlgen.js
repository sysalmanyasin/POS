// =========================================================================
// SQL GENERATOR — sqlgen.js
// Generates the complete Supabase schema SQL on demand.
// =========================================================================

function openSQLGeneratorModal() {
    const modal = document.getElementById('sqlGenModal');
    const ta    = document.getElementById('sqlGenText');
    if (!modal || !ta) return;
    ta.value = _buildSupabaseSQL();
    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('visible'));
}

function closeSQLGeneratorModal() {
    const modal = document.getElementById('sqlGenModal');
    if (!modal) return;
    modal.classList.remove('visible');
    setTimeout(() => { modal.style.display = 'none'; }, 260);
}

function copySQLToClipboard() {
    const ta  = document.getElementById('sqlGenText');
    const btn = document.getElementById('sqlCopyBtn');
    if (!ta) return;
    navigator.clipboard.writeText(ta.value).then(() => {
        if (btn) { const orig = btn.textContent; btn.textContent = '✅ Copied!'; setTimeout(() => { btn.textContent = orig; }, 2000); }
    }).catch(() => {
        ta.select(); document.execCommand('copy');
        if (btn) { const orig = btn.textContent; btn.textContent = '✅ Copied!'; setTimeout(() => { btn.textContent = orig; }, 2000); }
    });
}

function _buildSupabaseSQL() {
    return `-- ================================================================
-- PHARMA POS — Supabase Schema Setup
-- Paste this entire script into Supabase → SQL Editor → Run.
-- Safe to run more than once (all statements use IF NOT EXISTS).
-- ================================================================


-- ────────────────────────────────────────────────────────────────
-- TABLE 1: pharma_sync  (global key-value store)
-- Stores master password hash, remote wipe commands, etc.
-- ────────────────────────────────────────────────────────────────
create table if not exists pharma_sync (
    key        text        primary key,
    value      text,
    updated_at timestamptz not null default now()
);


-- ────────────────────────────────────────────────────────────────
-- TABLE 2: devices
-- ────────────────────────────────────────────────────────────────
create table if not exists devices (
    uuid          text        primary key,
    name          text        not null default '',
    counter_id    text        not null default 'Main',
    role          text        not null default 'client',
    is_active     boolean     not null default true,
    registered_at timestamptz not null default now(),
    last_seen_at  timestamptz not null default now(),
    today_bills   integer     not null default 0,
    active_staff  text
);


-- ────────────────────────────────────────────────────────────────
-- TABLE 3: invoices
-- ────────────────────────────────────────────────────────────────
create table if not exists invoices (
    invoice_number      text          primary key,
    device_uuid         text          not null default '',
    counter_id          text          not null default '',
    customer_name       text          not null default '',
    customer_phone      text          not null default '',
    staff_name          text          not null default '',
    subtotal            numeric(12,2) not null default 0,
    discount_pct        numeric(6,2)  not null default 0,
    discount_amount     numeric(12,2) not null default 0,
    round_off_amt       numeric(6,2)  not null default 0,
    net_total           numeric(12,2) not null default 0,
    payment_method      text          not null default 'cash',
    cash_received       numeric(12,2) not null default 0,
    change_amount       numeric(12,2) not null default 0,
    is_refund           boolean       not null default false,
    is_partial_refund   boolean       not null default false,
    is_manual           boolean       not null default false,
    is_fully_refunded   boolean       not null default false,
    original_invoice_id text,
    refund_reason       text          not null default '',
    is_edit             boolean       not null default false,
    billed_at           timestamptz   not null default now()
);

create index if not exists idx_invoices_billed_at   on invoices(billed_at desc);
create index if not exists idx_invoices_device_uuid on invoices(device_uuid);


-- ────────────────────────────────────────────────────────────────
-- TABLE 4: invoice_items  (line items per invoice)
-- ────────────────────────────────────────────────────────────────
create table if not exists invoice_items (
    invoice_number  text          not null references invoices(invoice_number) on delete cascade,
    product_code    text          not null,
    product_name    text          not null default '',
    pack_size       text          not null default '',
    unit_price      numeric(12,2) not null default 0,
    qty             integer       not null default 0,
    total           numeric(12,2) not null default 0,
    primary key (invoice_number, product_code)
);

create index if not exists idx_invoice_items_invoice on invoice_items(invoice_number);


-- ────────────────────────────────────────────────────────────────
-- TABLE 5: inventory  (version column drives OCC)
-- ────────────────────────────────────────────────────────────────
create table if not exists inventory (
    code          text          primary key,
    name          text          not null default '',
    generic_name  text          not null default '',
    pack_size     text          not null default '',
    unit_price    numeric(12,2) not null default 0,
    stock         integer       not null default 0,
    version       integer       not null default 1,
    uploaded_by   text          not null default '',
    uploaded_at   timestamptz   not null default now(),
    updated_at    timestamptz   not null default now()
);


-- ────────────────────────────────────────────────────────────────
-- TABLE 6: inventory_movements  (full audit trail)
-- movement_id is client-generated: invoiceNum_productCode_type
-- ────────────────────────────────────────────────────────────────
create table if not exists inventory_movements (
    movement_id     text        primary key,
    product_code    text        not null,
    quantity_change integer     not null,
    stock_after     integer     not null,
    movement_type   text        not null default 'SALE',
    invoice_number  text,
    device_uuid     text        not null default '',
    counter_id      text        not null default '',
    description     text        not null default '',
    moved_at        timestamptz not null default now()
);

create index if not exists idx_movements_product  on inventory_movements(product_code);
create index if not exists idx_movements_invoice  on inventory_movements(invoice_number);
create index if not exists idx_movements_moved_at on inventory_movements(moved_at desc);


-- ────────────────────────────────────────────────────────────────
-- TABLE 7: settings  (per-device key-value pairs)
-- ────────────────────────────────────────────────────────────────
create table if not exists settings (
    device_uuid  text        not null,
    key          text        not null,
    value        text,
    updated_at   timestamptz not null default now(),
    primary key (device_uuid, key)
);


-- ────────────────────────────────────────────────────────────────
-- TABLE 8: sync_log  (one row per background sync cycle)
-- ────────────────────────────────────────────────────────────────
create table if not exists sync_log (
    id               bigserial   primary key,
    device_uuid      text        not null,
    synced_at        timestamptz not null default now(),
    invoices_pushed  integer     not null default 0,
    invoices_pulled  integer     not null default 0,
    movements_pushed integer     not null default 0,
    movements_pulled integer     not null default 0
);

create index if not exists idx_sync_log_device on sync_log(device_uuid);


-- ────────────────────────────────────────────────────────────────
-- TABLE 9: sync_conflicts  (oversell / conflict records)
-- ────────────────────────────────────────────────────────────────
create table if not exists sync_conflicts (
    conflict_id    bigserial   primary key,
    device_uuid    text        not null,
    table_name     text        not null,
    record_key     text        not null,
    local_version  integer     not null default 0,
    server_version integer     not null default 0,
    local_payload  text,
    resolution     text        not null default 'MANUAL_REVIEW',
    detected_at    timestamptz not null default now()
);

create index if not exists idx_sync_conflicts_device on sync_conflicts(device_uuid);


-- ════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- App uses anon key only; app-level auth via master password.
-- Enable RLS but allow anon full access on all tables.
-- ════════════════════════════════════════════════════════════════
alter table pharma_sync         enable row level security;
alter table devices             enable row level security;
alter table invoices            enable row level security;
alter table invoice_items       enable row level security;
alter table inventory           enable row level security;
alter table inventory_movements enable row level security;
alter table settings            enable row level security;
alter table sync_log            enable row level security;
alter table sync_conflicts      enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='pharma_sync'         and policyname='anon_all') then
    create policy anon_all on pharma_sync         for all to anon using (true) with check (true); end if;
  if not exists (select 1 from pg_policies where tablename='devices'             and policyname='anon_all') then
    create policy anon_all on devices             for all to anon using (true) with check (true); end if;
  if not exists (select 1 from pg_policies where tablename='invoices'            and policyname='anon_all') then
    create policy anon_all on invoices            for all to anon using (true) with check (true); end if;
  if not exists (select 1 from pg_policies where tablename='invoice_items'       and policyname='anon_all') then
    create policy anon_all on invoice_items       for all to anon using (true) with check (true); end if;
  if not exists (select 1 from pg_policies where tablename='inventory'           and policyname='anon_all') then
    create policy anon_all on inventory           for all to anon using (true) with check (true); end if;
  if not exists (select 1 from pg_policies where tablename='inventory_movements' and policyname='anon_all') then
    create policy anon_all on inventory_movements for all to anon using (true) with check (true); end if;
  if not exists (select 1 from pg_policies where tablename='settings'            and policyname='anon_all') then
    create policy anon_all on settings            for all to anon using (true) with check (true); end if;
  if not exists (select 1 from pg_policies where tablename='sync_log'            and policyname='anon_all') then
    create policy anon_all on sync_log            for all to anon using (true) with check (true); end if;
  if not exists (select 1 from pg_policies where tablename='sync_conflicts'      and policyname='anon_all') then
    create policy anon_all on sync_conflicts      for all to anon using (true) with check (true); end if;
end $$;


-- ════════════════════════════════════════════════════════════════
-- STORED FUNCTION: deduct_inventory_atomic
-- Atomically deducts stock, increments version (OCC), and writes
-- the audit movement — all in one transaction.
-- Returns: (success, message, new_version, new_quantity)
-- ════════════════════════════════════════════════════════════════
create or replace function deduct_inventory_atomic(
    p_product_code      text,
    p_quantity          integer,
    p_device_uuid       text,
    p_invoice_number    text,
    p_expected_version  integer,
    p_movement_type     text default 'SALE'
)
returns table(success boolean, message text, new_version integer, new_quantity integer)
language plpgsql security definer
as $$
declare
    v_stock       integer;
    v_version     integer;
    v_new_stock   integer;
    v_new_version integer;
    v_qty_change  integer;
    v_movement_id text;
    v_counter_id  text;
begin
    select stock, version into v_stock, v_version
      from inventory where code = p_product_code for update;

    if not found then
        return query select false::boolean,
            ('Product not found: ' || p_product_code)::text, 0::integer, 0::integer;
        return;
    end if;

    if v_version <> p_expected_version then
        return query select false::boolean,
            ('OCC conflict: expected ' || p_expected_version || ' found ' || v_version)::text,
            v_version::integer, v_stock::integer;
        return;
    end if;

    if p_movement_type in ('REFUND', 'EDIT_RESTORE') then
        v_qty_change := p_quantity;
        v_new_stock  := v_stock + p_quantity;
    else
        if v_stock < p_quantity then
            return query select false::boolean,
                ('Insufficient stock: requested ' || p_quantity || ', available ' || v_stock)::text,
                v_version::integer, v_stock::integer;
            return;
        end if;
        v_qty_change := -p_quantity;
        v_new_stock  := v_stock - p_quantity;
    end if;

    v_new_version := v_version + 1;
    update inventory set stock=v_new_stock, version=v_new_version, updated_at=now()
     where code = p_product_code;

    select coalesce(counter_id,'') into v_counter_id
      from devices where uuid = p_device_uuid limit 1;

    v_movement_id := p_invoice_number || '_' || p_product_code || '_' || p_movement_type;
    insert into inventory_movements
        (movement_id, product_code, quantity_change, stock_after, movement_type,
         invoice_number, device_uuid, counter_id, description, moved_at)
    values
        (v_movement_id, p_product_code, v_qty_change, v_new_stock, p_movement_type,
         p_invoice_number, p_device_uuid, coalesce(v_counter_id,''),
         p_movement_type || ' via invoice ' || p_invoice_number, now())
    on conflict (movement_id) do nothing;

    return query select true::boolean, 'ok'::text, v_new_version::integer, v_new_stock::integer;
end;
$$;

-- ════════════════════════════════════════════════════════════════
-- EXPLICIT TABLE GRANTS
-- RLS policies control WHICH rows are visible/writable, but they
-- have no effect if the underlying table-level privilege for an
-- operation (especially DELETE) was never granted.  Supabase's
-- default project privileges vary by provisioning date, so we
-- grant everything explicitly here rather than relying on defaults.
-- Without this, DELETE silently no-ops on some projects even when
-- RLS allows it (e.g. Global Purge never actually removes devices).
-- ════════════════════════════════════════════════════════════════
grant select, insert, update, delete on table pharma_sync         to anon;
grant select, insert, update, delete on table devices             to anon;
grant select, insert, update, delete on table invoices            to anon;
grant select, insert, update, delete on table invoice_items       to anon;
grant select, insert, update, delete on table inventory           to anon;
grant select, insert, update, delete on table inventory_movements to anon;
grant select, insert, update, delete on table settings            to anon;
grant select, insert, update, delete on table sync_log            to anon;
grant select, insert, update, delete on table sync_conflicts      to anon;

-- sequence grants for bigserial columns (sync_log.id, sync_conflicts.conflict_id)
-- Using ALL SEQUENCES rather than named sequences avoids Supabase naming
-- convention differences (bigserial vs identity columns) across project versions.
grant usage, select on all sequences in schema public to anon;

grant execute on function deduct_inventory_atomic(text,integer,text,text,integer,text) to anon;
`;
}
