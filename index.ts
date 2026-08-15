// supabase/functions/whop-oauth-connect/index.ts
//
// Second half of "Sign in with Whop" (PKCE). The client already redirected the
// user to Whop, got a `code` back, and calls this function with that code.
// This exchanges it server-side and links the resulting Whop identity to the
// signed-in Supabase user.
//
// WHAT THIS DOES *NOT* DO, ON PURPOSE
// It does not store the Whop access/refresh tokens anywhere. Per Whop's own
// docs (docs.whop.com/developer/guides/oauth), the token exchange itself needs
// no client secret — PKCE is what makes that safe — so this function's only
// real job is to reliably learn the user's stable Whop identity (`sub`, e.g.
// "user_xxxxx") and record it. Ongoing subscription checks (in
// check-whop-access) use your COMPANY api key against that stored id, the
// same pattern Whop documents for SaaS integrations. That avoids holding a
// long-lived per-user OAuth token anywhere, which is both simpler (no refresh
// cycle to maintain) and a smaller attack surface if this database were ever
// compromised.
//
// SETUP
//   1. In the Whop developer dashboard, create an OAuth app (or via the API —
//      see the docs above) and add this exact redirect URI:
//        https://<your-domain>/  (must match character-for-character,
//        including the trailing slash, whatever you configure client-side)
//   2. supabase functions deploy whop-oauth-connect
//   3. supabase secrets set WHOP_CLIENT_ID=app_xxxxxxxxx
//      (WHOP_API_KEY / WHOP_PRODUCT_ID / WHOP_CHECKOUT_URL are already set
//      from check-whop-access — this function reuses WHOP_API_KEY.)
//
// UNVERIFIED AGAINST A LIVE ACCOUNT
// Built directly from Whop's current published docs, but this environment has
// no network access to actually run it against a real Whop app. Test the
// full connect flow with one real account before relying on it.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const WHOP_CLIENT_ID = Deno.env.get('WHOP_CLIENT_ID') ?? '';
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

  if (!WHOP_CLIENT_ID || !SUPABASE_URL || !SERVICE_ROLE) {
    return json({ error: 'Edge Function is missing required secrets.' }, 500);
  }

  let body: { code?: string; redirect_uri?: string; code_verifier?: string };
  try{ body = await req.json(); }
  catch{ return json({ error: 'Malformed request body.' }, 400); }

  const { code, redirect_uri, code_verifier } = body;
  if (!code || !redirect_uri || !code_verifier) {
    return json({ error: 'Missing code, redirect_uri, or code_verifier.' }, 400);
  }

  // Identify the caller from their Supabase auth token — same reasoning as
  // check-whop-access: never trust a user id passed in the request body.
  const authHeader = req.headers.get('Authorization') ?? '';
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data: userData, error: userErr } = await admin.auth.getUser(
    authHeader.replace(/^Bearer\s+/i, '')
  );
  if (userErr || !userData?.user) {
    return json({ error: 'Not signed in.' }, 401);
  }
  const supabaseUser = userData.user;

  // ---- exchange the code for a short-lived Whop access token ----
  let whopTokens: { access_token: string };
  try{
    const tokenRes = await fetch('https://api.whop.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri,
        client_id: WHOP_CLIENT_ID,
        code_verifier,
      }),
    });
    if (!tokenRes.ok) {
      const err = await tokenRes.json().catch(() => ({}));
      throw new Error(err.error_description || `token exchange failed (${tokenRes.status})`);
    }
    whopTokens = await tokenRes.json();
  }catch(e){
    return json({ error: `Could not complete Whop sign-in: ${(e as Error).message}` }, 502);
  }

  // ---- who did that token turn out to belong to? ----
  let whopUserId: string, whopUsername: string | null = null;
  try{
    const infoRes = await fetch('https://api.whop.com/oauth/userinfo', {
      headers: { Authorization: `Bearer ${whopTokens.access_token}` },
    });
    if (!infoRes.ok) throw new Error(`userinfo request failed (${infoRes.status})`);
    const info = await infoRes.json();
    if (!info.sub) throw new Error('Whop did not return a user id.');
    whopUserId = info.sub;
    whopUsername = info.preferred_username ?? info.name ?? null;
  }catch(e){
    return json({ error: `Could not read the connected Whop account: ${(e as Error).message}` }, 502);
  }

  // The short-lived access token has done its one job (proving identity) and
  // is deliberately discarded here rather than stored — see the file header.

  const { error: updateErr } = await admin.from('profiles').update({
    whop_user_id: whopUserId,
    whop_username: whopUsername,
  }).eq('id', supabaseUser.id);
  if (updateErr) {
    // 23505 = unique_violation. profiles_whop_user_id_unique means this exact
    // Whop account is already linked to a DIFFERENT Dinger Watch account —
    // report that plainly rather than a raw database error.
    if (updateErr.code === '23505') {
      return json({ error: 'That Whop account is already connected to a different Dinger Watch account.' }, 409);
    }
    return json({ error: `Connected to Whop, but couldn't save it: ${updateErr.message}` }, 500);
  }

  return json({ ok: true, whopUserId, whopUsername });
});
