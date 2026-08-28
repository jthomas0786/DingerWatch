// supabase/functions/place-wager-validated/index.ts
//
// Closes a real, actively-exploitable bug: place_wager() itself never
// checked whether a leg's outcome was already known before accepting a
// wager on it — meaning someone could watch a home run happen live, then
// immediately wager on that exact player, guaranteed to win every time.
//
// Why this has to be an edge function and not just an extra check inside
// place_wager() itself: plain Postgres functions can't make a live,
// synchronous call out to MLB's API and block on the real answer within
// the same transaction — pg_net (the extension that lets Postgres reach
// external HTTP endpoints) is built for fire-and-forget async requests,
// not "call out, wait, then decide." A periodically-updated table would
// only narrow the exploit window, not close it, and for something this
// exploitable a narrowed window isn't good enough. Edge functions run on
// Deno and can make real, synchronous fetch() calls — so this checks the
// actual live game state at the exact moment someone tries to wager, not
// a cached value from the last poll a few minutes ago.
//
// This does not replace place_wager() or weaken anything it already does
// — every one of its own checks (balance, stake, signed-in) still run
// exactly as before. This only adds one more gate in front of it: every
// leg has to prove its outcome ISN'T already decided before place_wager()
// ever gets called at all.

import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Same field paths as settle-wagers.js's playerResultFromFeed() —
 * deliberately kept identical, so "already happened" means the same thing
 * wherever it's checked, rather than three slightly different
 * interpretations of the same live data drifting apart over time.
 */
function playerResultFromFeed(data: any, playerId: number) {
  const status = data?.gameData?.status;
  const abstractState: string | null = status?.abstractGameState || null; // "Preview" | "Live" | "Final"
  const teams = data?.liveData?.boxscore?.teams;
  const sides = [teams?.away, teams?.home].filter(Boolean);
  let hr = 0;
  let appeared = false;
  for (const side of sides) {
    const p = side?.players?.["ID" + playerId];
    const batting = p?.stats?.batting;
    if (p && batting?.atBats != null) {
      appeared = true;
      hr = Math.max(hr, batting.homeRuns ?? 0);
    }
  }
  return { abstractState, hr, appeared };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let body: { stake?: number; legs?: any[] };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid request body" }, 400);
  }

  const { stake, legs } = body;
  if (!Array.isArray(legs) || legs.length === 0) {
    return jsonResponse({ error: "at least one leg is required" }, 400);
  }

  // Fetch each distinct game's live feed exactly once, fresh, right now —
  // not a cached or periodically-updated value. That's the entire point:
  // the answer has to be true at this exact instant, not "true as of the
  // last poll a few minutes ago."
  const gameFeedCache = new Map<number, Promise<any>>();
  const fetchGame = (gamePk: number) => {
    if (!gameFeedCache.has(gamePk)) {
      gameFeedCache.set(
        gamePk,
        fetch(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      );
    }
    return gameFeedCache.get(gamePk)!;
  };

  for (const leg of legs) {
    const gamePk = Number(leg?.game_pk);
    const playerId = Number(leg?.player_id);
    if (!gamePk || !playerId) {
      return jsonResponse({ error: "each leg needs a real game and player" }, 400);
    }

    const feed = await fetchGame(gamePk);
    if (!feed) {
      // Couldn't verify this leg's current state right now — refuse
      // rather than guess. A genuine, temporary MLB API hiccup means "try
      // again in a moment," not "let it through unchecked."
      return jsonResponse(
        { error: `Couldn't verify ${leg?.player_name || "a player"}'s current game state — try again in a moment.` },
        503,
      );
    }

    const r = playerResultFromFeed(feed, playerId);
    if (r.hr >= 1) {
      return jsonResponse(
        { error: `${leg?.player_name || "That player"} has already homered — this pick is no longer wagerable.` },
        409,
      );
    }
    if (r.abstractState === "Final") {
      return jsonResponse(
        { error: `${leg?.player_name || "That player"}'s game is already over — this pick is no longer wagerable.` },
        409,
      );
    }
  }

  // Every leg checked out — forward to the real RPC using the CALLING
  // user's own auth token, not the service role, so place_wager()'s own
  // auth.uid()-based logic and every existing check inside it keep working
  // exactly as they did before this function existed.
  const authHeader = req.headers.get("Authorization") ?? "";
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data, error } = await supabase.rpc("place_wager", {
    stake_amount: stake,
    legs_json: legs,
  });

  if (error) {
    return jsonResponse({ error: error.message }, 400);
  }

  return jsonResponse({ wager_id: data });
});
