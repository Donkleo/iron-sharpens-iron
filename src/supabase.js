import { createClient } from "@supabase/supabase-js";

// Filled in at build time from the repo's Actions secrets SUPABASE_URL and
// SUPABASE_ANON_KEY (see .github/workflows/deploy.yml). The anon key is meant
// to be public; the database's access rules are what keep prayers private.
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const configured = Boolean(url && key);

export const supabase = configured
  ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;
