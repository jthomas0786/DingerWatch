/**
 * social.js — accounts, emoji reactions, chat, and follows.
 *
 * Loads Supabase from a CDN and exposes a small API the dashboard calls. If
 * Supabase isn't configured, every function no-ops and the app runs exactly as
 * it did before — social features are additive, never load-bearing.
 *
 * SETUP
 *   1. Create a project at supabase.com (free tier)
 *   2. Run supabase-schema.sql in the SQL editor
 *   3. Fill in the two constants below from Settings → API
 *
 * The anon key below is PUBLIC by design — it identifies the project and grants
 * no privileges on its own. Row Level Security in supabase-schema.sql is what
 * actually protects the data, so those policies must stay enabled.
 *
 * Never replace it with the service_role key: that one bypasses RLS entirely
 * and would let any visitor read or delete every row in the database.
 */

const SUPABASE_URL = 'https://hjhfbhpuuxnrexddplxd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhqaGZiaHB1dXhucmV4ZGRwbHhkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0OTY5ODQsImV4cCI6MjEwMjA3Mjk4NH0.6URv-aSJgFupp1dkO65AsTqPpZF_aUckczhxJZBWVJ0';

let sb = null;                 // Supabase client
let currentUser = null;        // { id, username, avatar_seed }
let socialReady = false;
let profileError = null;   // surfaced in the UI when a profile can't be made
let schemaMissing = false; // true when the SQL schema hasn't been installed

const socialEnabled = () => !!(SUPABASE_URL && SUPABASE_ANON_KEY);

/** Load the SDK only when configured, so an unconfigured site pays nothing. */
async function initSocial(){
  if(!socialEnabled()) return false;
  try{
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // Confirm the schema is actually installed before anything tries to use it.
    // Without this the first failure the user sees is a raw PostgREST error
    // from whichever feature they happened to touch first.
    const { error: probe } = await sb.from('profiles').select('id').limit(1);
    if(probe && (probe.code === 'PGRST205' || /schema cache|does not exist/i.test(probe.message))){
      schemaMissing = true;
      console.error('[social] Supabase tables are missing. Run supabase-schema.sql in the SQL editor.');
    }

    const { data: { session } } = await sb.auth.getSession();
    if(session) await loadProfile(session.user.id);

    // IMPORTANT: this callback must not await a Supabase call. The client holds
    // an internal lock while it runs, and querying from inside can deadlock —
    // the await never resolves, so the profile never loads and the UI still
    // looks signed out. Defer the work outside the callback instead.
    sb.auth.onAuthStateChange((_event, session) => {
      if(!session){
        currentUser = null;
        notifyAuthChanged();
        return;
      }
      setTimeout(async () => {
        await loadProfile(session.user.id);
        notifyAuthChanged();
      }, 0);
    });

    socialReady = true;
    return true;
  }catch(e){
    console.warn('[social] init failed:', e.message);
    return false;
  }
}

async function loadProfile(userId){
  const { data, error } = await sb.from('profiles').select('*').eq('id', userId).single();
  if(data){ currentUser = data; return; }

  // No profile row. This happens when the account was created before the schema
  // was installed, or if the signup trigger didn't fire. Faking a user object
  // here would be worse than useless: messages.user_id has a foreign key to
  // profiles(id), so every post would fail with an FK violation while the UI
  // insisted you were signed in. Create the row instead.
  console.warn('[social] no profile row for', userId, '— creating one');
  const { data: authUser } = await sb.auth.getUser();
  const meta = authUser?.user?.user_metadata || {};
  const fallbackName = meta.username || 'fan_' + userId.replace(/-/g, '').slice(0, 8);

  const { data: created, error: insErr } = await sb.from('profiles')
    .insert({ id: userId, username: fallbackName, avatar_seed: userId.replace(/-/g, '').slice(0, 12) })
    .select()
    .single();

  if(insErr){
    // Username collision is recoverable; anything else means the schema is
    // missing or RLS is misconfigured, and the user must be told.
    if(insErr.code === '23505'){
      const unique = fallbackName + '_' + userId.slice(0, 4);
      const { data: retry } = await sb.from('profiles')
        .insert({ id: userId, username: unique, avatar_seed: userId.replace(/-/g, '').slice(0, 12) })
        .select().single();
      if(retry){ currentUser = retry; return; }
    }
    console.error('[social] could not create profile:', insErr.message);
    profileError = insErr.message;
    currentUser = null;      // stay signed out rather than half-broken
    return;
  }
  currentUser = created;
}

/** Let the page repaint whenever auth state settles. */
function notifyAuthChanged(){
  try{ window.dispatchEvent(new CustomEvent('dw-auth-changed')); }catch{}
}

// ---------------------------------------------------------------- auth
async function signUp(email, password, username){
  if(!/^[a-zA-Z0-9_]{3,20}$/.test(username)){
    return { error: 'Username must be 3–20 characters, letters/numbers/underscore only.' };
  }
  // Check availability first so the user isn't told after creating an account.
  const { data: taken } = await sb.from('profiles').select('id').eq('username', username).maybeSingle();
  if(taken) return { error: 'That username is taken.' };

  const { data, error } = await sb.auth.signUp({
    email, password,
    options: { data: { username } },   // the DB trigger reads this
  });
  if(error) return { error: error.message };

  // When email confirmation is disabled in the project, signUp returns a live
  // session and the user is already in. Only claim "check your email" when
  // there genuinely is no session.
  if(data?.session?.user){
    await loadProfile(data.session.user.id);
    notifyAuthChanged();
    return { ok: true, needsConfirm: false };
  }
  return { ok: true, needsConfirm: true };
}

async function signIn(email, password){
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if(error){
    // Supabase's default wording here is vague; name the common cause.
    const msg = /email not confirmed/i.test(error.message)
      ? 'Check your email and click the confirmation link first.'
      : error.message;
    return { error: msg };
  }
  // Load the profile before resolving, so the caller can render a signed-in UI
  // immediately instead of racing the auth listener.
  if(data?.user) await loadProfile(data.user.id);
  notifyAuthChanged();
  return { ok: true };
}

async function signOut(){
  await sb.auth.signOut();
  currentUser = null;
  notifyAuthChanged();
  return { ok: true };
}

// ---------------------------------------------------------------- reactions
/**
 * Stable identity for a prop across users and sessions. Date-scoped so
 * tomorrow's Ohtani HR is a different thing from today's.
 */
function propKey(slateDate, player, market, line){
  return `${slateDate}|${player}|${market}|${line}`;
}

const REACTION_EMOJI = ['🔥','💣','🔒','👀','🤡','💀'];

let reactionCache = new Map();   // propKey -> { emoji: {count, mine} }

async function loadReactions(propKeys){
  if(!socialReady || !propKeys.length) return;
  const { data, error } = await sb.from('reactions')
    .select('prop_key, emoji, user_id')
    .in('prop_key', propKeys);
  if(error){ console.warn('[social] reactions load failed:', error.message); return; }

  const map = new Map();
  for(const r of data){
    if(!map.has(r.prop_key)) map.set(r.prop_key, {});
    const bucket = map.get(r.prop_key);
    bucket[r.emoji] = bucket[r.emoji] || { count: 0, mine: false };
    bucket[r.emoji].count++;
    if(currentUser && r.user_id === currentUser.id) bucket[r.emoji].mine = true;
  }
  for(const [k, v] of map) reactionCache.set(k, v);
}

async function toggleReaction(key, emoji){
  if(!currentUser){ promptSignIn(); return; }

  const bucket = reactionCache.get(key) || {};
  const mine = bucket[emoji]?.mine;

  // Update locally first so the tap feels instant, then reconcile.
  bucket[emoji] = bucket[emoji] || { count: 0, mine: false };
  bucket[emoji].count += mine ? -1 : 1;
  bucket[emoji].mine = !mine;
  if(bucket[emoji].count <= 0) delete bucket[emoji];
  reactionCache.set(key, bucket);
  renderReactionsFor(key);

  const q = mine
    ? sb.from('reactions').delete().match({ user_id: currentUser.id, prop_key: key, emoji })
    : sb.from('reactions').insert({ user_id: currentUser.id, prop_key: key, emoji });

  const { error } = await q;
  if(error){
    console.warn('[social] reaction failed:', error.message);
    // Roll the optimistic update back rather than leaving a lie on screen.
    await loadReactions([key]);
    renderReactionsFor(key);
  }
}

/** Synchronous read of cached counts, for render paths that can't await. */
function reactionsFor(key){
  return reactionCache.get(key) || {};
}

/** Warm the cache for everything currently on screen, then repaint. */
async function primeReactions(keys, onDone){
  await loadReactions(keys);
  if(onDone) onDone();
}

// ---------------------------------------------------------------- chat
let chatSub = null;
let chatMessages = [];

async function loadChat(room = 'general', limit = 60){
  if(!socialReady) return [];
  const { data, error } = await sb.from('messages')
    .select('id, body, created_at, prop_key, user_id, profiles(username, avatar_seed)')
    .eq('room', room)
    .order('created_at', { ascending: false })
    .limit(limit);
  if(error){ console.warn('[social] chat load failed:', error.message); return []; }
  chatMessages = data.reverse();   // oldest first for display
  return chatMessages;
}

async function sendMessage(body, room = 'general', propKey = null){
  if(schemaMissing){
    return { error: 'Database tables are missing. Run supabase-schema.sql in the Supabase SQL editor, then reload.' };
  }
  if(!currentUser){
    return { error: profileError
      ? 'Your profile could not be created: ' + profileError
      : 'not signed in' };
  }
  const trimmed = body.trim();
  if(!trimmed) return { error: 'empty' };
  if(trimmed.length > 500) return { error: 'Message too long (500 max).' };

  const { data, error } = await sb.from('messages')
    .insert({ user_id: currentUser.id, room, body: trimmed, prop_key: propKey })
    .select('id, body, created_at, prop_key, user_id')
    .single();

  if(error){
    // Translate the failures that actually happen into something actionable.
    let msg = error.message;
    if(error.code === '23503') msg = 'Your profile row is missing — sign out and back in.';
    else if(error.code === '42501' || /row-level security/i.test(msg))
      msg = 'Blocked by row-level security. Re-run supabase-schema.sql.';
    else if(/relation .* does not exist/i.test(msg))
      msg = 'The messages table does not exist. Run supabase-schema.sql.';
    console.error('[social] send failed:', error);
    return { error: msg };
  }

  // Return the row so the UI can show it immediately — realtime may be off or
  // slow, and a message that posts but never appears reads as a failure.
  return { ok: true, message: { ...data, profiles: { username: currentUser.username,
                                                     avatar_seed: currentUser.avatar_seed } } };
}

/** Realtime subscription. Returns an unsubscribe function. */
function subscribeChat(room, onMessage){
  if(!socialReady) return () => {};
  if(chatSub) sb.removeChannel(chatSub);
  chatSub = sb.channel(`chat:${room}`)
    .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `room=eq.${room}` },
        async payload => {
          // The realtime payload has no joined profile, so fetch the author.
          const { data: prof } = await sb.from('profiles')
            .select('username, avatar_seed').eq('id', payload.new.user_id).single();
          onMessage({ ...payload.new, profiles: prof });
        })
    .subscribe();
  return () => { if(chatSub){ sb.removeChannel(chatSub); chatSub = null; } };
}

// ---------------------------------------------------------------- follows
async function toggleFollow(followeeId){
  if(!currentUser){ promptSignIn(); return; }
  if(followeeId === currentUser.id) return;   // schema forbids it too

  const { data: existing } = await sb.from('follows')
    .select('follower_id')
    .match({ follower_id: currentUser.id, followee_id: followeeId })
    .maybeSingle();

  if(existing){
    await sb.from('follows').delete().match({ follower_id: currentUser.id, followee_id: followeeId });
    return { following: false };
  }
  const { error } = await sb.from('follows')
    .insert({ follower_id: currentUser.id, followee_id: followeeId });
  return error ? { error: error.message } : { following: true };
}

async function followCounts(userId){
  if(!socialReady) return { followers: 0, following: 0 };
  const [{ count: followers }, { count: following }] = await Promise.all([
    sb.from('follows').select('*', { count: 'exact', head: true }).eq('followee_id', userId),
    sb.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', userId),
  ]);
  return { followers: followers || 0, following: following || 0 };
}

/** Picks from people you follow. */
async function followingFeed(limit = 50){
  if(!socialReady || !currentUser) return [];
  const { data, error } = await sb.rpc('following_feed', { limit_n: limit });
  if(error){ console.warn('[social] feed failed:', error.message); return []; }
  return data;
}

// ---------------------------------------------------------------- picks
async function publishPick(pick){
  if(!currentUser){ promptSignIn(); return { error: 'not signed in' }; }
  const { error } = await sb.from('picks').insert({
    user_id: currentUser.id,
    prop_key: pick.key, player: pick.player, market: pick.market,
    line: pick.line, side: pick.side || 'over',
    price: pick.price ?? null, grade: pick.grade ?? null,
    note: pick.note ?? null, slate_date: pick.slateDate,
  });
  // A duplicate is the user re-posting the same pick — not worth an error.
  if(error && error.code === '23505') return { ok: true, duplicate: true };
  return error ? { error: error.message } : { ok: true };
}


// ---------------------------------------------------------------- exports
export {
  initSocial, socialEnabled,
  signUp, signIn, signOut,
  propKey, toggleReaction, loadReactions, REACTION_EMOJI,
  loadChat, sendMessage, subscribeChat,
  toggleFollow, followCounts, followingFeed,
  publishPick, reactionsFor, primeReactions,
};
export const getUser = () => currentUser;
export const isReady = () => socialReady;
export const needsSchema = () => schemaMissing;
// Live binding: ES module exports of `let` update for importers automatically,
// so the dashboard's `s.socialReady` reflects the real state.
export { socialReady, currentUser };
