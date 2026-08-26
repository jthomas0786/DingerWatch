-- ============================================================================
--  POINTS WAGERING SYSTEM
--  Shared across the whole account (Dinger/Touchdown/Goal/Bucket switcher) —
--  wagers.sport defaults to 'mlb' today, but the balance and ledger are
--  already sport-agnostic, so nothing here needs to change when wagering
--  comes to the other sport apps later.
--  Run after everything above. Safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
--  Config — editable without a redeploy, same reason model-config.json lives
--  outside the app instead of hardcoded. Both the client (showing odds
--  before a wager is placed) and the settlement job need to read the same
--  live value, so this lives in the database, not a file only the server
--  side would see.
-- ---------------------------------------------------------------------------
create table if not exists wager_config (
  key    text primary key,
  value  numeric not null
);

insert into wager_config (key, value) values
  ('house_edge', 0.07),
  ('max_payout_multiplier', 20),
  ('base_weekly_allowance', 100)
on conflict (key) do nothing;

alter table wager_config enable row level security;

drop policy if exists "anyone can read wager config" on wager_config;
create policy "anyone can read wager config"
  on wager_config for select using (true);
-- No insert/update/delete policy for regular users on purpose — writes only
-- happen via the service role, same as every other "trusted server only"
-- write in this schema.

-- ---------------------------------------------------------------------------
--  Balance + ledger
-- ---------------------------------------------------------------------------
create table if not exists point_balances (
  user_id     uuid primary key references profiles(id) on delete cascade,
  balance     integer not null default 0,
  updated_at  timestamptz default now()
);

alter table point_balances enable row level security;

drop policy if exists "users read their own balance" on point_balances;
create policy "users read their own balance"
  on point_balances for select using (auth.uid() = user_id);
-- No client insert/update policy at all — every balance change goes through
-- place_wager() below or the service-role settlement/allowance jobs. A user
-- should never be able to write their own balance directly, even narrowed
-- to "own row only."

create table if not exists point_transactions (
  id          bigserial primary key,
  user_id     uuid not null references profiles(id) on delete cascade,
  type        text not null,   -- 'weekly_allowance' | 'wager_placed' | 'wager_won' | 'wager_refunded'
  amount      integer not null,   -- positive or negative
  wager_id    bigint,
  note        text,
  created_at  timestamptz default now()
);

create index if not exists point_transactions_user_idx on point_transactions(user_id, created_at desc);

alter table point_transactions enable row level security;

drop policy if exists "users read their own transactions" on point_transactions;
create policy "users read their own transactions"
  on point_transactions for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
--  Wagers — a single bet and a parlay are the same shape: one wagers row
--  (the slip) with one or more wager_legs underneath. A straight bet is
--  just a parlay with exactly one leg, so both run through identical
--  placement and settlement logic rather than two parallel systems.
-- ---------------------------------------------------------------------------
create table if not exists wagers (
  id                     bigserial primary key,
  user_id                uuid not null references profiles(id) on delete cascade,
  sport                  text not null default 'mlb',
  stake                  integer not null check (stake > 0),
  combined_decimal_odds  numeric not null,
  potential_payout       integer not null,
  status                 text not null default 'pending',  -- pending | won | lost | void
  placed_at              timestamptz default now(),
  settled_at             timestamptz
);

create index if not exists wagers_user_idx on wagers(user_id, placed_at desc);
create index if not exists wagers_status_idx on wagers(status) where status = 'pending';

alter table wagers enable row level security;

drop policy if exists "users read their own wagers" on wagers;
create policy "users read their own wagers"
  on wagers for select using (auth.uid() = user_id);
-- No insert policy — wagers are only ever created via place_wager() (runs
-- as the definer, bypasses this table's RLS for its own insert). No update/
-- delete policy for users at all; settlement is service-role only.

create table if not exists wager_legs (
  id                     bigserial primary key,
  wager_id               bigint not null references wagers(id) on delete cascade,
  player_id              integer not null,
  player_name            text not null,
  game_pk                integer not null,
  slate_date             date not null,
  market                 text not null default 'hr_0.5+',
  probability_at_wager   numeric not null,
  leg_decimal_odds       numeric not null,
  status                 text not null default 'pending',  -- pending | won | lost | void
  resolved_reason        text,
  settled_at             timestamptz
);

create index if not exists wager_legs_wager_idx on wager_legs(wager_id);
create index if not exists wager_legs_pending_idx on wager_legs(player_id, game_pk) where status = 'pending';

alter table wager_legs enable row level security;

drop policy if exists "users read legs of their own wagers" on wager_legs;
create policy "users read legs of their own wagers"
  on wager_legs for select using (
    exists (select 1 from wagers w where w.id = wager_legs.wager_id and w.user_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
--  Check-ins — powers the weekly allowance multiplier. Deliberately just a
--  log of distinct active days, not a running streak counter: no
--  consecutiveness requirement, so missing one day only costs credit for
--  that day, never threatens any other day's credit. The primary key alone
--  prevents double-counting the same day — no "already checked in today"
--  branching needed anywhere.
-- ---------------------------------------------------------------------------
create table if not exists checkins (
  user_id       uuid not null references profiles(id) on delete cascade,
  checkin_date  date not null,
  primary key (user_id, checkin_date)
);

alter table checkins enable row level security;

drop policy if exists "users read their own checkins" on checkins;
create policy "users read their own checkins"
  on checkins for select using (auth.uid() = user_id);

drop policy if exists "users insert their own checkin" on checkins;
create policy "users insert their own checkin"
  on checkins for insert with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
--  place_wager — the one place points actually move on the client side.
--  SECURITY DEFINER so it can atomically check balance, debit it, and
--  insert the wager + legs as one transaction — no window for a fast
--  double-submit to spend the same points twice, which a raw client insert
--  could not safely guarantee on its own.
--
--  legs_json shape: [{"player_id":123,"player_name":"...","game_pk":456,
--    "slate_date":"2026-08-25","probability":0.30}, ...]
--  Odds for each leg are computed HERE, server-side, from the live
--  house_edge config — never trusted from the client — so nobody can
--  submit a wager with odds better than what the config actually allows.
-- ---------------------------------------------------------------------------
create or replace function place_wager(stake_amount integer, legs_json jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id           uuid := auth.uid();
  v_house_edge        numeric;
  v_max_multiplier    numeric;
  v_combined_odds     numeric := 1;
  v_leg               jsonb;
  v_leg_odds          numeric;
  v_shaded_prob       numeric;
  v_wager_id          bigint;
  v_potential_payout  integer;
  v_rows_updated      integer;
begin
  if v_user_id is null then
    raise exception 'not signed in';
  end if;
  if stake_amount is null or stake_amount <= 0 then
    raise exception 'stake must be positive';
  end if;
  if jsonb_array_length(legs_json) = 0 then
    raise exception 'at least one leg is required';
  end if;

  select value into v_house_edge from wager_config where key = 'house_edge';
  select value into v_max_multiplier from wager_config where key = 'max_payout_multiplier';
  v_house_edge := coalesce(v_house_edge, 0.07);
  v_max_multiplier := coalesce(v_max_multiplier, 20);

  -- Atomic check-and-debit: this UPDATE only succeeds if the row both
  -- exists and already has enough balance. If it affects zero rows, the
  -- user either has no balance row yet or genuinely can't cover the stake
  -- — either way, abort before anything else is touched.
  update point_balances
    set balance = balance - stake_amount, updated_at = now()
    where user_id = v_user_id and balance >= stake_amount;
  get diagnostics v_rows_updated = row_count;
  if v_rows_updated = 0 then
    raise exception 'insufficient balance';
  end if;

  -- Compute combined odds across every leg before inserting anything.
  for v_leg in select * from jsonb_array_elements(legs_json)
  loop
    v_shaded_prob := least(0.90, (v_leg->>'probability')::numeric * (1 + v_house_edge));
    if v_shaded_prob <= 0 then
      raise exception 'invalid probability on a leg';
    end if;
    v_leg_odds := 1 / v_shaded_prob;
    v_combined_odds := v_combined_odds * v_leg_odds;
  end loop;

  v_combined_odds := least(v_combined_odds, v_max_multiplier);
  v_potential_payout := round(stake_amount * v_combined_odds);

  insert into wagers (user_id, stake, combined_decimal_odds, potential_payout)
    values (v_user_id, stake_amount, v_combined_odds, v_potential_payout)
    returning id into v_wager_id;

  for v_leg in select * from jsonb_array_elements(legs_json)
  loop
    v_shaded_prob := least(0.90, (v_leg->>'probability')::numeric * (1 + v_house_edge));
    v_leg_odds := 1 / v_shaded_prob;
    insert into wager_legs (
      wager_id, player_id, player_name, game_pk, slate_date,
      probability_at_wager, leg_decimal_odds
    ) values (
      v_wager_id,
      (v_leg->>'player_id')::integer,
      v_leg->>'player_name',
      (v_leg->>'game_pk')::integer,
      (v_leg->>'slate_date')::date,
      (v_leg->>'probability')::numeric,
      v_leg_odds
    );
  end loop;

  insert into point_transactions (user_id, type, amount, wager_id, note)
    values (v_user_id, 'wager_placed', -stake_amount, v_wager_id, null);

  return v_wager_id;
end;
$$;
