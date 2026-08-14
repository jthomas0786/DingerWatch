-- ============================================================================
--  Dinger Watch — social schema
-- ----------------------------------------------------------------------------
--  Run this once in the Supabase SQL editor.
--
--  SECURITY NOTE: every table has Row Level Security enabled. The anon key
--  shipped in your frontend is PUBLIC — anyone can read it and call the API
--  directly. RLS is the only thing standing between that and someone deleting
--  every message on the site. Policies below are written so a user can only
--  ever modify their own rows.
-- ============================================================================

-- ---------------------------------------------------------------- profiles
-- One row per user, created automatically on signup by the trigger below.
create table if not exists profiles (
  id          uuid primary key references auth.users on delete cascade,
  username    text unique not null check (
                username ~ '^[a-zA-Z0-9_]{3,20}$'   -- keeps mentions unambiguous
              ),
  avatar_seed text,                                  -- deterministic avatar art
  team        text check (char_length(team) <= 4),   -- favourite club, optional
  created_at  timestamptz default now()
);

alter table profiles enable row level security;

-- Profiles are public: you need to see who wrote a message or who you follow.
create policy "profiles are readable by everyone"
  on profiles for select using (true);

create policy "users insert their own profile"
  on profiles for insert with check (auth.uid() = id);

create policy "users update their own profile"
  on profiles for update using (auth.uid() = id);

-- Create the profile automatically so the client never has to, which avoids a
-- window where a signed-in user exists with no profile row.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username, avatar_seed)
  values (
    new.id,
    -- Fall back to a generated handle if none was supplied at signup.
    coalesce(
      new.raw_user_meta_data->>'username',
      'fan_' || substr(replace(new.id::text, '-', ''), 1, 8)
    ),
    substr(replace(new.id::text, '-', ''), 1, 12)
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------- reactions
-- An emoji reaction on a specific prop, e.g. "Ohtani HR over 0.5" on a date.
create table if not exists reactions (
  id         bigserial primary key,
  user_id    uuid not null references profiles(id) on delete cascade,
  prop_key   text not null,          -- "2026-08-11|Shohei Ohtani|HR|0.5"
  emoji      text not null check (char_length(emoji) <= 8),
  created_at timestamptz default now(),
  -- One of each emoji per user per prop; tapping again removes it.
  unique (user_id, prop_key, emoji)
);

create index if not exists reactions_prop_idx on reactions(prop_key);

alter table reactions enable row level security;

create policy "reactions are readable by everyone"
  on reactions for select using (true);

create policy "users add their own reactions"
  on reactions for insert with check (auth.uid() = user_id);

create policy "users remove their own reactions"
  on reactions for delete using (auth.uid() = user_id);

-- Aggregated counts, so the client fetches one small row per prop instead of
-- every individual reaction.
create or replace view reaction_counts as
  select prop_key, emoji, count(*)::int as count
  from reactions
  group by prop_key, emoji;

-- ---------------------------------------------------------------- messages
create table if not exists messages (
  id         bigserial primary key,
  user_id    uuid not null references profiles(id) on delete cascade,
  room       text not null default 'general' check (char_length(room) <= 40),
  body       text not null check (char_length(body) between 1 and 500),
  prop_key   text,                   -- set when a message is attached to a prop
  created_at timestamptz default now()
);

create index if not exists messages_room_idx on messages(room, created_at desc);

alter table messages enable row level security;

create policy "messages are readable by everyone"
  on messages for select using (true);

create policy "users post as themselves"
  on messages for insert with check (auth.uid() = user_id);

-- Deliberately no UPDATE policy: edited chat history is confusing and abusable.
create policy "users delete their own messages"
  on messages for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------- follows
create table if not exists follows (
  follower_id uuid not null references profiles(id) on delete cascade,
  followee_id uuid not null references profiles(id) on delete cascade,
  created_at  timestamptz default now(),
  primary key (follower_id, followee_id),
  -- Following yourself would pollute every feed and count.
  constraint no_self_follow check (follower_id <> followee_id)
);

create index if not exists follows_followee_idx on follows(followee_id);

alter table follows enable row level security;

create policy "follows are readable by everyone"
  on follows for select using (true);

create policy "users create their own follows"
  on follows for insert with check (auth.uid() = follower_id);

create policy "users remove their own follows"
  on follows for delete using (auth.uid() = follower_id);

-- ---------------------------------------------------------------- picks feed
-- A user publishing a pick, which is what followers actually want to see.
create table if not exists picks (
  id         bigserial primary key,
  user_id    uuid not null references profiles(id) on delete cascade,
  prop_key   text not null,
  player     text not null,
  market     text not null,
  line       text not null,
  side       text not null default 'over' check (side in ('over','under')),
  price      int,                    -- american odds at time of posting
  grade      text,                   -- the app's grade when posted
  note       text check (char_length(note) <= 280),
  slate_date date not null,
  created_at timestamptz default now(),
  unique (user_id, prop_key, slate_date)
);

create index if not exists picks_user_idx on picks(user_id, created_at desc);
create index if not exists picks_date_idx on picks(slate_date, created_at desc);

alter table picks enable row level security;

create policy "picks are readable by everyone"
  on picks for select using (true);

create policy "users post their own picks"
  on picks for insert with check (auth.uid() = user_id);

create policy "users delete their own picks"
  on picks for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------- realtime
-- Push new rows to subscribed clients without polling.
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table reactions;
alter publication supabase_realtime add table picks;

-- ---------------------------------------------------------------- helpers
-- Feed of picks from people you follow. SECURITY INVOKER so RLS still applies.
create or replace function following_feed(limit_n int default 50)
returns table (
  id bigint, username text, avatar_seed text, player text, market text,
  line text, side text, price int, grade text, note text, created_at timestamptz
)
language sql security invoker
as $$
  select p.id, pr.username, pr.avatar_seed, p.player, p.market, p.line,
         p.side, p.price, p.grade, p.note, p.created_at
  from picks p
  join profiles pr on pr.id = p.user_id
  where p.user_id in (
    select followee_id from follows where follower_id = auth.uid()
  )
  order by p.created_at desc
  limit limit_n;
$$;
