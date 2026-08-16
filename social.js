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
    .select('id, body, created_at, prop_key, user_id, profiles(username, avatar_seed, avatar_url)')
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
                                                     avatar_seed: currentUser.avatar_seed,
                                                     avatar_url: currentUser.avatar_url } } };
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
            .select('username, avatar_seed, avatar_url').eq('id', payload.new.user_id).single();
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

// ---------------------------------------------------------------- presence
// Who's online. Supabase Realtime Presence keeps a shared roster per channel
// and drops entries automatically when a tab closes, so there's no stale-user
// cleanup to write.
let presenceChannel = null;
let onlineUsers = [];

function joinPresence(onChange){
  if(!socialReady || !currentUser) return () => {};
  if(presenceChannel) sb.removeChannel(presenceChannel);

  presenceChannel = sb.channel('online', {
    config: { presence: { key: currentUser.id } },
  });

  const sync = () => {
    const state = presenceChannel.presenceState();
    // One entry per user even with several tabs open.
    const seen = new Map();
    for(const key of Object.keys(state)){
      const meta = state[key][0];
      if(meta) seen.set(key, meta);
    }
    onlineUsers = [...seen.values()];
    if(onChange) onChange(onlineUsers);
  };

  presenceChannel
    .on('presence', { event: 'sync' }, sync)
    .on('presence', { event: 'join' }, sync)
    .on('presence', { event: 'leave' }, sync)
    .subscribe(async status => {
      if(status !== 'SUBSCRIBED') return;
      await presenceChannel.track({
        id: currentUser.id,
        username: currentUser.username,
        avatar_seed: currentUser.avatar_seed,
        avatar_url: currentUser.avatar_url,
        online_at: new Date().toISOString(),
      });
    });

  return () => { if(presenceChannel){ sb.removeChannel(presenceChannel); presenceChannel = null; } };
}

const getOnlineUsers = () => onlineUsers;

// ---------------------------------------------------------------- profiles
async function getProfile(username){
  if(!socialReady) return null;
  const { data, error } = await sb.from('profiles')
    .select('*').ilike('username', username).maybeSingle();
  if(error){ console.warn('[social] profile fetch failed:', error.message); return null; }
  return data;
}

async function updateProfile(fields){
  if(!currentUser) return { error: 'not signed in' };
  const allowed = {};
  // Only these are editable; never let the client set id or created_at.
  for(const k of ['display_name', 'bio', 'team', 'avatar_url']) {
    if(fields[k] !== undefined) allowed[k] = fields[k];
  }
  if(fields.username !== undefined){
    const u = String(fields.username).trim();
    if(!/^[a-zA-Z0-9_]{3,20}$/.test(u)) return { error: 'Username must be 3–20 characters: letters, numbers, underscore.' };
    const { data: taken } = await sb.from('profiles')
      .select('id').ilike('username', u).neq('id', currentUser.id).maybeSingle();
    if(taken) return { error: 'That username is taken.' };
    allowed.username = u;
  }
  allowed.updated_at = new Date().toISOString();

  const { data, error } = await sb.from('profiles')
    .update(allowed).eq('id', currentUser.id).select().single();
  if(error) return { error: error.message };
  currentUser = data;
  notifyAuthChanged();
  return { ok: true, profile: data };
}

async function isFollowing(userId){
  if(!socialReady || !currentUser) return false;
  const { data } = await sb.from('follows').select('follower_id')
    .match({ follower_id: currentUser.id, followee_id: userId }).maybeSingle();
  return !!data;
}

// ---------------------------------------------------------------- whop access gate
/**
 * Calls the check-whop-access Edge Function, which does the real work
 * server-side (Whop's API needs a secret key that must never reach the
 * browser). Returns { hasAccess, connected, checkoutUrl } or { error }.
 * `connected: false` means no Whop account has been linked yet — distinct
 * from "connected but not subscribed" so the UI can show the right prompt.
 *
 * Rate-limited client-side: a fresh sign-in always re-checks, but repeated
 * calls within a short window reuse the cached result on the profile rather
 * than hitting the Edge Function (and Whop's API) on every render.
 */
const WHOP_RECHECK_MS = 5 * 60 * 1000;   // 5 minutes

async function checkWhopAccess(force = false){
  if(!currentUser) return { error: 'not signed in' };

  if(!force && currentUser.whop_checked_at){
    const age = Date.now() - new Date(currentUser.whop_checked_at).getTime();
    if(age < WHOP_RECHECK_MS){
      return { hasAccess: !!currentUser.whop_access, connected: !!currentUser.whop_user_id, cached: true };
    }
  }

  const { data: sess } = await sb.auth.getSession();
  const token = sess?.session?.access_token;
  if(!token) return { error: 'not signed in' };

  try{
    const { data, error } = await sb.functions.invoke('check-whop-access', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if(error) return { error: error.message || 'Could not reach the access check.' };
    if(data?.error) return { error: data.error };

    currentUser.whop_access = !!data.hasAccess;
    currentUser.whop_checked_at = new Date().toISOString();

    return { hasAccess: !!data.hasAccess, connected: !!data.connected, checkoutUrl: data.checkoutUrl };
  }catch(e){
    return { error: e?.message || 'Could not reach the access check.' };
  }
}

// ---------------------------------------------------------------- whop oauth connect
/**
 * "Sign in with Whop" via OAuth 2.1 + PKCE, per Whop's documented flow
 * (docs.whop.com/developer/guides/oauth). PKCE means the code exchange needs
 * no client secret, so the redirect and the verifier can both live safely on
 * the client — only the final "who does this belong to" step goes through an
 * Edge Function (whop-oauth-connect), since that's what writes to the database.
 *
 * WHOP_CLIENT_ID is the OAuth app id (looks like "app_xxxxx"). Unlike an API
 * key, this is meant to be public — every OAuth provider's client_id is
 * embedded in client-side code the same way (Google, GitHub, etc.).
 */
const WHOP_CLIENT_ID = 'app_QdNZC391lkoy4R';

// A FIXED redirect URI, not derived from location.origin/pathname. Whop
// requires an exact character-for-character match against what's registered
// in your OAuth app settings, and deriving it dynamically from wherever the
// page happens to be loaded means the string can silently differ depending on
// how someone reached your site (with/without index.html, with/without a
// trailing slash, the old GitHub Pages path vs a custom domain) — producing
// exactly the 'redirect_uri is invalid' error even though the app 'looks'
// like it's running from the right place. Set this to ONE canonical URL and
// register that exact same string in the Whop dashboard.
const WHOP_REDIRECT_URI = 'https://dingerwatch.app/';   // e.g. 'https://dingerwatch.app/' — include the trailing slash
const WHOP_OAUTH_STORAGE_KEY = 'dw_whop_pkce';

function whopOAuthConfigured(){ return !!WHOP_CLIENT_ID; }

function base64url(bytes){
  let bin = '';
  for(const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function randomString(len){ return base64url(crypto.getRandomValues(new Uint8Array(len))); }
async function sha256(str){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return base64url(new Uint8Array(buf));
}

/** Redirects the browser to Whop. Nothing after this line runs — the page navigates away. */
async function startWhopConnect(){
  if(!whopOAuthConfigured()) return { error: 'Whop connect is not configured yet.' };

  const pkce = { codeVerifier: randomString(32), state: randomString(16) };
  sessionStorage.setItem(WHOP_OAUTH_STORAGE_KEY, JSON.stringify(pkce));

  // Fixed, not derived from location — see WHOP_REDIRECT_URI above for why.
  if(!WHOP_REDIRECT_URI) return { error: 'WHOP_REDIRECT_URI is not set in social.js.' };
  const redirectUri = WHOP_REDIRECT_URI;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: WHOP_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid profile email',
    state: pkce.state,
    code_challenge: await sha256(pkce.codeVerifier),
    code_challenge_method: 'S256',
  });
  location.href = `https://api.whop.com/oauth/authorize?${params}`;
  return { ok: true };   // never actually observed — the page has navigated away
}

/**
 * Call once on every page load. If the URL is Whop redirecting back
 * (?code=...&state=...), completes the connection and cleans the URL so a
 * refresh doesn't attempt to resubmit the same code. Returns null when the
 * current load isn't an OAuth callback at all — the common case.
 */
async function handleWhopOAuthCallback(){
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if(!code) return null;

  const cleanUrl = () => {
    const url = new URL(location.href);
    url.searchParams.delete('code'); url.searchParams.delete('state'); url.searchParams.delete('error');
    history.replaceState({}, '', url.toString());
  };

  const returnedState = params.get('state');
  const oauthError = params.get('error');
  if(oauthError){ cleanUrl(); return { error: `Whop sign-in was cancelled or failed: ${oauthError}` }; }

  let stored;
  try{ stored = JSON.parse(sessionStorage.getItem(WHOP_OAUTH_STORAGE_KEY) || 'null'); }catch{ stored = null; }
  sessionStorage.removeItem(WHOP_OAUTH_STORAGE_KEY);
  cleanUrl();

  if(!stored || returnedState !== stored.state){
    return { error: 'Whop sign-in could not be verified (state mismatch) — please try connecting again.' };
  }
  if(!currentUser){
    return { error: "You'll need to be signed in to Dinger Watch before connecting Whop." };
  }
  if(!WHOP_REDIRECT_URI){
    return { error: 'WHOP_REDIRECT_URI is not set in social.js — cannot complete the connection.' };
  }

  const { data: sess } = await sb.auth.getSession();
  const token = sess?.session?.access_token;
  if(!token) return { error: 'not signed in' };

  try{
    const { data, error } = await sb.functions.invoke('whop-oauth-connect', {
      body: { code, redirect_uri: WHOP_REDIRECT_URI, code_verifier: stored.codeVerifier },
      headers: { Authorization: `Bearer ${token}` },
    });
    if(error) return { error: error.message || 'Could not complete the Whop connection.' };
    if(data?.error) return { error: data.error };

    currentUser.whop_user_id = data.whopUserId;
    currentUser.whop_username = data.whopUsername;
    return { ok: true };
  }catch(e){
    return { error: e?.message || 'Could not complete the Whop connection.' };
  }
}

// ---------------------------------------------------------------- avatars
/**
 * Resize any uploaded photo to a small square before it ever leaves the
 * device. A raw phone-camera photo can be 5-10MB; nobody needs that for a
 * 52px circle, and uploading it as-is would be slow on mobile data and waste
 * storage quota. Cropped to a centered square, capped at 320px, encoded JPEG.
 */
function resizeToSquare(file, size = 320){
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('resize failed')), 'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not read that image')); };
    img.src = url;
  });
}

async function uploadAvatar(file){
  if(!currentUser) return { error: 'not signed in' };
  if(!file.type?.startsWith('image/')) return { error: 'Please choose an image file.' };
  if(file.size > 15 * 1024 * 1024) return { error: 'Image is too large (15MB max before resizing).' };

  let blob;
  try{ blob = await resizeToSquare(file); }
  catch(e){ return { error: e.message || 'Could not process that image.' }; }

  const path = `${currentUser.id}/avatar.jpg`;
  const { error: upErr } = await sb.storage.from('avatars')
    .upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
  if(upErr) return { error: upErr.message };

  const { data: pub } = sb.storage.from('avatars').getPublicUrl(path);
  // Cache-bust: the path never changes on re-upload, so without this the
  // browser (and any CDN in front of storage) would keep showing the old photo.
  const url = `${pub.publicUrl}?t=${Date.now()}`;

  return updateProfile({ avatar_url: url });
}

async function setAvatarPreset(presetId){
  if(!currentUser) return { error: 'not signed in' };
  return updateProfile({ avatar_url: `preset:${presetId}` });
}

// ---------------------------------------------------------------- statuses
async function postStatus(body, legs = null, slateDate = null){
  if(!currentUser) return { error: 'not signed in' };
  const trimmed = String(body || '').trim();
  if(!trimmed) return { error: 'Say something first.' };
  if(trimmed.length > 500) return { error: 'Status too long (500 max).' };

  const { data, error } = await sb.from('statuses')
    .insert({ user_id: currentUser.id, body: trimmed, legs, slate_date: slateDate })
    .select().single();
  if(error) return { error: error.message };
  return { ok: true, status: { ...data, username: currentUser.username,
                               display_name: currentUser.display_name,
                               avatar_seed: currentUser.avatar_seed,
                               avatar_url: currentUser.avatar_url,
                               comment_count: 0, reaction_count: 0 } };
}

async function deleteStatus(id){
  if(!currentUser) return { error: 'not signed in' };
  const { error } = await sb.from('statuses').delete().match({ id, user_id: currentUser.id });
  return error ? { error: error.message } : { ok: true };
}

/** Statuses for one user, or the global feed when userId is null. */
async function loadStatuses({ userId = null, limit = 40 } = {}){
  if(!socialReady) return [];
  let q = sb.from('status_feed').select('*').order('created_at', { ascending: false }).limit(limit);
  if(userId) q = q.eq('user_id', userId);
  const { data, error } = await q;
  if(error){ console.warn('[social] statuses failed:', error.message); return []; }
  return data;
}

/** Statuses from people the signed-in user follows. */
async function loadFollowingStatuses(limit = 40){
  if(!socialReady || !currentUser) return [];
  const { data: f } = await sb.from('follows').select('followee_id').eq('follower_id', currentUser.id);
  const ids = (f || []).map(r => r.followee_id);
  if(!ids.length) return [];
  const { data, error } = await sb.from('status_feed').select('*')
    .in('user_id', ids).order('created_at', { ascending: false }).limit(limit);
  if(error){ console.warn('[social] following feed failed:', error.message); return []; }
  return data;
}

// ---------------------------------------------------------------- comments
async function loadComments(statusId){
  if(!socialReady) return [];
  const { data, error } = await sb.from('comments')
    .select('id, body, created_at, user_id, profiles(username, avatar_seed, avatar_url)')
    .eq('status_id', statusId).order('created_at');
  if(error){ console.warn('[social] comments failed:', error.message); return []; }
  return data;
}

async function postComment(statusId, body){
  if(!currentUser) return { error: 'not signed in' };
  const trimmed = String(body || '').trim();
  if(!trimmed) return { error: 'empty' };
  if(trimmed.length > 300) return { error: 'Comment too long (300 max).' };
  const { data, error } = await sb.from('comments')
    .insert({ status_id: statusId, user_id: currentUser.id, body: trimmed })
    .select('id, body, created_at, user_id').single();
  if(error) return { error: error.message };
  return { ok: true, comment: { ...data, profiles: { username: currentUser.username,
                                                     avatar_seed: currentUser.avatar_seed,
                                                     avatar_url: currentUser.avatar_url } } };
}

// ------------------------------------------------------- status reactions
let statusRxCache = new Map();   // statusId -> { emoji: {count, mine} }

async function loadStatusReactions(statusIds){
  if(!socialReady || !statusIds.length) return;
  const { data, error } = await sb.from('status_reactions')
    .select('status_id, emoji, user_id').in('status_id', statusIds);
  if(error) return;
  const map = new Map();
  for(const r of data){
    if(!map.has(r.status_id)) map.set(r.status_id, {});
    const b = map.get(r.status_id);
    b[r.emoji] = b[r.emoji] || { count: 0, mine: false };
    b[r.emoji].count++;
    if(currentUser && r.user_id === currentUser.id) b[r.emoji].mine = true;
  }
  for(const id of statusIds) statusRxCache.set(id, map.get(id) || {});
}

const statusReactionsFor = id => statusRxCache.get(id) || {};

async function toggleStatusReaction(statusId, emoji){
  if(!currentUser) return { error: 'not signed in' };
  const b = statusRxCache.get(statusId) || {};
  const mine = b[emoji]?.mine;

  b[emoji] = b[emoji] || { count: 0, mine: false };
  b[emoji].count += mine ? -1 : 1;
  b[emoji].mine = !mine;
  if(b[emoji].count <= 0) delete b[emoji];
  statusRxCache.set(statusId, b);

  const q = mine
    ? sb.from('status_reactions').delete().match({ status_id: statusId, user_id: currentUser.id, emoji })
    : sb.from('status_reactions').insert({ status_id: statusId, user_id: currentUser.id, emoji });
  const { error } = await q;
  if(error){ await loadStatusReactions([statusId]); return { error: error.message }; }
  return { ok: true };
}

// ---------------------------------------------------------------- notifications
async function loadNotifications(limit = 50){
  if(!socialReady || !currentUser) return [];
  const { data, error } = await sb.from('notifications')
    .select('id, type, payload, read, created_at, actor_id')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if(error){ console.warn('[social] notifications load failed:', error.message); return []; }
  return data;
}

async function markAllNotificationsRead(){
  if(!currentUser) return { error: 'not signed in' };
  const { error } = await sb.from('notifications')
    .update({ read: true }).eq('user_id', currentUser.id).eq('read', false);
  return error ? { error: error.message } : { ok: true };
}

/**
 * A notification the CURRENT user creates for themselves — used for at-bat
 * watch alerts, which are detected client-side by the watching user's own
 * browser polling live game state. RLS only allows self-inserts (see schema),
 * so this can never be used to notify anyone else.
 */
async function selfNotify(type, payload){
  if(!currentUser) return { error: 'not signed in' };
  const { data, error } = await sb.from('notifications')
    .insert({ user_id: currentUser.id, actor_id: currentUser.id, type, payload })
    .select().single();
  // A duplicate at-bat notification (e.g. two tabs open) hits the unique
  // index rather than an error the user needs to see.
  if(error && error.code === '23505') return { ok: true, duplicate: true };
  return error ? { error: error.message } : { ok: true, notification: data };
}

let notifChannel = null;

/** Realtime: new notification rows addressed to this user, e.g. a comment or follow arriving. */
function subscribeNotifications(onInsert){
  if(!socialReady || !currentUser) return () => {};
  if(notifChannel) sb.removeChannel(notifChannel);
  notifChannel = sb.channel(`notif:${currentUser.id}`)
    .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${currentUser.id}` },
        payload => onInsert(payload.new))
    .subscribe();
  return () => { if(notifChannel){ sb.removeChannel(notifChannel); notifChannel = null; } };
}

// ---------------------------------------------------------------- watchlist
const todayStr = () => new Intl.DateTimeFormat('en-CA', { timeZone:'America/Chicago',
  year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());

async function getWatchlist(date = todayStr()){
  if(!socialReady || !currentUser) return [];
  const { data, error } = await sb.from('watchlist')
    .select('player_id, player_name, team, slate_date')
    .eq('user_id', currentUser.id).eq('slate_date', date);
  if(error){ console.warn('[social] watchlist load failed:', error.message); return []; }
  return data;
}

async function addToWatchlist(player, date = todayStr()){
  if(!currentUser) return { error: 'not signed in' };
  const { error } = await sb.from('watchlist').insert({
    user_id: currentUser.id, player_id: player.id, player_name: player.name,
    team: player.team ?? null, slate_date: date,
  });
  // Already on the list — not an error the UI needs to show.
  if(error && error.code === '23505') return { ok: true, already: true };
  return error ? { error: error.message } : { ok: true };
}

async function removeFromWatchlist(playerId, date = todayStr()){
  if(!currentUser) return { error: 'not signed in' };
  const { error } = await sb.from('watchlist').delete()
    .match({ user_id: currentUser.id, player_id: playerId, slate_date: date });
  return error ? { error: error.message } : { ok: true };
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
  checkWhopAccess, startWhopConnect, handleWhopOAuthCallback, whopOAuthConfigured,
  loadNotifications, markAllNotificationsRead, selfNotify, subscribeNotifications,
  getWatchlist, addToWatchlist, removeFromWatchlist,
  joinPresence, getOnlineUsers,
  getProfile, updateProfile, isFollowing,
  postStatus, deleteStatus, loadStatuses, loadFollowingStatuses,
  loadComments, postComment,
  loadStatusReactions, statusReactionsFor, toggleStatusReaction,
  uploadAvatar, setAvatarPreset,
};
export const getUser = () => currentUser;
export const isReady = () => socialReady;
export const needsSchema = () => schemaMissing;
// Live binding: ES module exports of `let` update for importers automatically,
// so the dashboard's `s.socialReady` reflects the real state.
export { socialReady, currentUser };
