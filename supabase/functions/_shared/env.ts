// Reads required environment variables (Supabase secrets) once at startup.
// If any are missing, the function refuses to work instead of failing silently.

export type EnvResult<K extends string> =
  | { ok: true; values: Record<K, string> }
  | { ok: false; missing: K[] };

export function readEnv<K extends string>(
  names: readonly K[],
  get: (name: string) => string | undefined = (n) => Deno.env.get(n),
): EnvResult<K> {
  const values = {} as Record<K, string>;
  const missing: K[] = [];
  for (const name of names) {
    const value = get(name)?.trim();
    if (value) values[name] = value;
    else missing.push(name);
  }
  return missing.length ? { ok: false, missing } : { ok: true, values };
}
