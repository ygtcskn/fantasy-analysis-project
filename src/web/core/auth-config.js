"use strict";

// The Supabase project that signs visitors in (core/auth.js). Both values are
// public by design: every visitor's browser receives them, and what a signed-in
// user may read or change is enforced by Supabase, never by keeping these
// secret. The secret (service_role) key must never appear here or anywhere in
// src/web. With url empty, sign-in is off and the sidebar shows no account area.
const SITE_AUTH = {
  url: "https://olbgtnuvwrqoqyakqswu.supabase.co",  // Supabase → Project Settings → API → Project URL, https://<ref>.supabase.co
  key: "sb_publishable_afttzqrJGrbgeyqyzMlVrw_teb4-5mU",  // Supabase → Project Settings → API Keys → publishable (anon) key
  // Ways to sign in, in the order offered. Keep only those switched on in
  // Supabase → Authentication → Sign In / Providers. Email links need custom
  // SMTP: Supabase's own sender reaches only the project's team.
  providers: ["email"],
};

