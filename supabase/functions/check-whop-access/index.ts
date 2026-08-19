// supabase/functions/check-whop-access/index.ts
//
// Checks whether the CALLING (authenticated) user has an active Whop
// membership for Dinger Watch, and returns { hasAccess, connected, checkoutUrl }.
//
// This is the OAuth-identity version: rather than matching by email (fragile
// — the Whop checkout email and the Dinger Watch account email might differ),
// it reads the stable Whop user id (whop_user_id) recorded by
// whop-oauth-connect when the user connected their account, and checks that
// specific user's access with your COMPANY api key. If whop_user_id is empty,
// `connected: false` is returned so the client can prompt "Connect your Whop
// account" rather than a generic "you're not subscribed."
//
// WHY THIS STILL HAS TO BE SERVER-SIDE
// The company API key used here is a secret that must never reach the
// browser — same reasoning as before, unchanged by the switch to OAuth.
//
// SETUP
//   1. supabase functions deploy check-whop-access
//   2. supabase secrets set WHOP_API_KEY=your_company_api_key
//   3. supabase secrets set WHOP_PRODUCT_IDS=prod_xxxxxxxx
//      (comma-separated for more than one — see WHOP_PRODUCT_IDS below)
//   4. supabase secrets set WHOP_CHECKOUT_URL=https://whop.com/your-product/
//
// Uses Whop's official SDK (via Deno's npm: specifier) for the actual access
// check rather than a hand-built REST call, so it tracks Whop's real endpoint
// shape rather than a guess at one. Not tested against a live account from
// this environment — verify with one real subscribed account before relying
// on it for production access control.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Whop from 'npm:@whop/sdk';

const WHOP_API_KEY      = Deno.env.get('WHOP_API_KEY') ?? '';
// One or more product ids, comma-separated — access is granted if the user
// has a valid membership to ANY of them. Covers e.g. a paid tier plus a
// separate free/VIP product: WHOP_PRODUCT_IDS=prod_paidtier,prod_vipfree
const WHOP_PRODUCT_IDS = (Deno.env.get('WHOP_PRODUCT_IDS') ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);
const WHOP_CHECKOUT_URL = Deno.env.get('WHOP_CHECKOUT_URL') ?? 'https://whop.com/';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  if (!WHOP_API_KEY || !SUPABASE_URL || !SERVICE_ROLE) {
    return json({ error: 'Edge Function is missing required secrets (WHOP_API_KEY / Supabase config).' }, 500);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  const { data: userData, error: userErr } = await admin.auth.getUser(
    authHeader.replace(/^Bearer\s+/i, '')
  );
  if (userErr || !userData?.user) {
    return json({ error: 'Not signed in.' }, 401);
  }
  const user = userData.user;

  const { data: profile, error: profErr } = await admin
    .from('profiles').select('whop_user_id, whop_username').eq('id', user.id).single();
  if (profErr) {
    return json({ error: `Could not read profile: ${profErr.message}` }, 500);
  }

  if (!profile?.whop_user_id) {
    return json({ hasAccess: false, connected: false, checkoutUrl: WHOP_CHECKOUT_URL });
  }

  if (WHOP_PRODUCT_IDS.length === 0) {
    return json({ error: 'WHOP_PRODUCT_IDS is not configured.' }, 500);
  }

  // Access is granted if the user holds a valid membership to ANY of the
  // configured products — e.g. a paid tier and a separate free/VIP tier both
  // count. Checked independently per product (not at the company level),
  // so an unrelated product sold under the same Whop company later doesn't
  // silently start granting access here too.
  let hasAccess = false;
  const perProductErrors: string[] = [];
  const client = new Whop({ apiKey: WHOP_API_KEY });

  for (const productId of WHOP_PRODUCT_IDS) {
    try{
      const result = await client.users.checkAccess(productId, { id: profile.whop_user_id });
      if (result?.has_access) { hasAccess = true; break; }   // found one — no need to check the rest
    }catch(e){
      // Don't let one bad product id (e.g. a typo) silently deny a real
      // subscriber to a DIFFERENT configured product — keep checking the
      // others, but remember the failure so it can be surfaced if nothing
      // else grants access either.
      perProductErrors.push(`${productId}: ${(e as Error).message}`);
    }
  }

  if (!hasAccess && perProductErrors.length > 0) {
    // At least one lookup failed and none of the successful ones granted
    // access — report the error rather than confidently saying "not
    // subscribed," since the failure could be masking a real subscriber.
    return json({ error: `Could not verify Whop subscription: ${perProductErrors.join('; ')}` }, 502);
  }

  await admin.from('profiles').update({
    whop_access: hasAccess,
    whop_checked_at: new Date().toISOString(),
  }).eq('id', user.id);

  // whopUsername is echoed back so the client can show WHICH Whop account is
  // linked. Without it, a user who connected the wrong Whop account sees only
  // "no subscription found" and has no way to tell that the gate is checking
  // somebody else's account — the exact failure this was added to diagnose.
  return json({
    hasAccess,
    connected: true,
    whopUsername: profile.whop_username ?? null,
    checkoutUrl: WHOP_CHECKOUT_URL,
  });
});