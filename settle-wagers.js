/**
 * settle-wagers.js — scheduled job that resolves pending wager legs against
 * real MLB game data, and settles whole wagers once every leg is decided.
 *
 * Run via GitHub Actions on a schedule (settle-wagers.yml). Uses the
 * Supabase service-role key — this bypasses RLS entirely, same as
 * send-push.js already does, since a scheduled job has no signed-in user
 * to act as.
 *
 * THE ONE THING THIS SCRIPT CANNOT GET WRONG: crediting a payout twice.
 * Every write that moves points is behind a conditional UPDATE (...&status
 * =eq.pending in the query string) with `Prefer: return=representation`,
 * and the script only proceeds to credit points if THAT SPECIFIC call
 * actually returned the updated row. If two runs somehow overlap, or this
 * job is accidentally triggered twice for the same window, the second run
 * finds nothing left in 'pending' state to transition, updates zero rows,
 * and correctly does nothing further. This is the same pattern
 * place_wager() uses inside a single SQL transaction (a conditional UPDATE
 * that only proceeds if it actually affected a row) — reimplemented here
 * as a sequence of REST calls since a scheduled job runs outside the
 * database and can't wrap everything in one transaction the way a SQL
 * function can.
 *
 * FIELD PATHS BELOW ARE VERIFIED, NOT GUESSED — copied directly from the
 * live app's own already-working parsing of this exact endpoint
 * (extractBoxSide() and playerHRResult() in index.html), not derived from
 * general knowledge of the MLB Stats API. Same endpoint the client already
 * polls every 20 seconds: v1.1/game/{gamePk}/feed/live.
 *
 * Env vars required (set as GitHub Actions secrets):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if(!SUPABASE_URL || !SERVICE_KEY){
  console.error('[settle] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

async function sb(path, options = {}){
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if(!res.ok){
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase ${options.method || 'GET'} ${path} -> ${res.status}: ${body}`);
  }
  // 204 No Content (default PATCH/POST response without return=representation)
  if(res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Same v1.1 live-feed endpoint the client already polls — cached per run
 *  so a slate with several pending legs on the same game only fetches it
 *  once, not once per leg. */
const gameStateCache = new Map();
async function fetchGameState(gamePk){
  if(gameStateCache.has(gamePk)) return gameStateCache.get(gamePk);
  const promise = (async () => {
    try{
      const res = await fetch(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`);
      if(!res.ok) return null;
      return await res.json();
    }catch(e){
      console.warn(`[settle] couldn't fetch game ${gamePk}:`, e.message);
      return null;
    }
  })();
  gameStateCache.set(gamePk, promise);
  return promise;
}

/** Mirrors playerHRResult() in index.html exactly — same field paths,
 *  verified against the app's own already-working extractBoxSide(). */
function playerResultFromFeed(data, playerId){
  const status = data?.gameData?.status;
  const abstractState = status?.abstractGameState || null;   // "Preview" | "Live" | "Final"
  const detailedState = status?.detailedState || null;       // e.g. "In Progress", "Postponed", "Final"

  const teams = data?.liveData?.boxscore?.teams;
  const sides = [teams?.away, teams?.home].filter(Boolean);
  let hr = 0, appeared = false, found = false;

  for(const side of sides){
    const p = side?.players?.['ID' + playerId];
    const batting = p?.stats?.batting;
    if(p){
      found = true;
      if(batting?.atBats != null){
        appeared = true;
        hr = Math.max(hr, batting.homeRuns ?? 0);
      }
    }
  }

  return { abstractState, detailedState, hr, appeared, playerFound: found };
}

/** Resolves one pending leg against its game's current state, or leaves it
 *  alone if the game hasn't reached a decidable point yet. */
function decideLeg(leg, feedData){
  if(!feedData) return null;   // couldn't fetch the game this run — try again next time

  const r = playerResultFromFeed(feedData, leg.player_id);

  // A home run that's already happened is a confirmed win regardless of
  // whether the game itself has finished yet.
  if(r.hr >= 1) return { status: 'won', reason: `hit ${r.hr} HR` };

  if(r.detailedState === 'Postponed' || r.detailedState === 'Cancelled'){
    return { status: 'void', reason: `game ${r.detailedState.toLowerCase()}` };
  }

  if(r.abstractState === 'Final'){
    if(!r.playerFound || !r.appeared){
      // Scratched from the lineup, or never got an at-bat (e.g. pinch-hit
      // for before batting) — void rather than lost, same fairness
      // treatment a real sportsbook applies to a player who didn't play.
      return { status: 'void', reason: 'player did not appear in the box score' };
    }
    return { status: 'lost', reason: 'no HR, game final' };
  }

  return null;   // still in progress, no HR yet — leave pending
}

/** Credits points and logs the transaction. Only ever called after the
 *  caller's own conditional UPDATE confirmed THIS run is the one that
 *  transitioned the wager out of 'pending' — see settleWager() below. */
async function creditPoints(userId, amount, wagerId, type, note){
  const [existing] = await sb(`/point_balances?user_id=eq.${userId}&select=balance`) || [];
  if(existing){
    await sb(`/point_balances?user_id=eq.${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ balance: existing.balance + amount, updated_at: new Date().toISOString() }),
    });
  }else{
    await sb('/point_balances', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, balance: amount, updated_at: new Date().toISOString() }),
    });
  }
  await sb('/point_transactions', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, type, amount, wager_id: wagerId, note }),
  });
}

/** Checks whether a wager's legs are all decided, and if so, settles the
 *  whole wager exactly once. Safe to call redundantly — the conditional
 *  UPDATE below is what actually guarantees the "exactly once" part. */
async function trySettleWager(wagerId){
  const legs = await sb(`/wager_legs?wager_id=eq.${wagerId}&select=status`);
  if(!legs.length || legs.some(l => l.status === 'pending')) return;   // still waiting on something

  const anyVoid = legs.some(l => l.status === 'void');
  const allWon = legs.every(l => l.status === 'won');
  const finalStatus = anyVoid ? 'void' : allWon ? 'won' : 'lost';

  // The &status=eq.pending here is the entire double-credit guard: this
  // only returns a row if THIS call is the one that actually flipped the
  // wager out of pending. A second, redundant call (from an overlapping
  // run, or this wager being reconsidered on a later run for any reason)
  // finds nothing left to update and gets an empty array back.
  const updated = await sb(`/wagers?id=eq.${wagerId}&status=eq.pending`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: finalStatus, settled_at: new Date().toISOString() }),
  });
  const wager = updated?.[0];
  if(!wager) return;   // already settled by another run — do nothing further

  if(finalStatus === 'won'){
    await creditPoints(wager.user_id, wager.potential_payout, wager.id, 'wager_won', 'wager settled — won');
    console.log(`[settle] wager ${wagerId} WON — credited ${wager.potential_payout} pts to user ${wager.user_id}`);
  }else if(finalStatus === 'void'){
    await creditPoints(wager.user_id, wager.stake, wager.id, 'wager_refunded', 'wager voided — stake refunded');
    console.log(`[settle] wager ${wagerId} VOID — refunded ${wager.stake} pts to user ${wager.user_id}`);
  }else{
    // Lost: no further action. The stake was already debited from the
    // user's balance at placement time inside place_wager() — there's
    // nothing left to move.
    console.log(`[settle] wager ${wagerId} LOST — no payout`);
  }
}

async function main(){
  const pendingLegs = await sb('/wager_legs?status=eq.pending&select=*');
  if(!pendingLegs.length){
    console.log('[settle] no pending legs — nothing to do');
    return;
  }
  console.log(`[settle] ${pendingLegs.length} pending leg(s) across ${new Set(pendingLegs.map(l=>l.game_pk)).size} game(s)`);

  const affectedWagerIds = new Set();

  for(const leg of pendingLegs){
    const feedData = await fetchGameState(leg.game_pk);
    const decision = decideLeg(leg, feedData);
    if(!decision) continue;   // not decidable yet

    // Same conditional-update guard as the wager-level settlement below —
    // only proceed with anything downstream if this call actually
    // transitioned this specific leg out of pending.
    const updated = await sb(`/wager_legs?id=eq.${leg.id}&status=eq.pending`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: decision.status, resolved_reason: decision.reason, settled_at: new Date().toISOString() }),
    });
    if(updated?.[0]){
      console.log(`[settle] leg ${leg.id} (${leg.player_name}) -> ${decision.status}: ${decision.reason}`);
      affectedWagerIds.add(leg.wager_id);
    }
  }

  for(const wagerId of affectedWagerIds){
    await trySettleWager(wagerId);
  }

  console.log(`[settle] done — ${affectedWagerIds.size} wager(s) touched this run`);
}

main().catch(e => {
  console.error('[settle] run failed:', e);
  process.exit(1);
});
