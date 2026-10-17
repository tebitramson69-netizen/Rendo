// Server-side Supabase client. Uses a SECRET key, so it bypasses Row Level Security:
// it must only ever run inside Edge Functions, never in a browser.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { ClaimResult } from "./types.ts";

export type { ClaimResult };

function pickSecretKey(): string {
  // New API keys: SUPABASE_SECRET_KEYS is a JSON object of named secret keys.
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const keys = JSON.parse(raw) as Record<string, string>;
      const key = keys["default"] ?? Object.values(keys)[0];
      if (key) return key;
    } catch {
      // fall through to the legacy key
    }
  }
  // Legacy fallback while it still exists.
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  throw new Error("No Supabase secret key available in the Edge Function environment");
}

let client: SupabaseClient | null = null;

export function adminClient(): SupabaseClient {
  if (!client) {
    const url = Deno.env.get("SUPABASE_URL");
    if (!url) throw new Error("SUPABASE_URL is not set");
    client = createClient(url, pickSecretKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/**
 * Records a WhatsApp message id. Returns "duplicate" if Meta already delivered it,
 * so the same message is never answered twice.
 */
export async function claimMessage(db: SupabaseClient, wamid: string): Promise<ClaimResult> {
  const { error } = await db.from("processed_webhook_events").insert({ wamid });
  if (!error) return "new";
  if (error.code === "23505") return "duplicate"; // unique_violation
  console.error("claimMessage failed", error.code || error.message);
  return "error";
}
