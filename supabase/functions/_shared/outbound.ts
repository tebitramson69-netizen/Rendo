// Rendo M3 — messages the bot wants to send, as plain data (no network here).
// The sender (whatsapp.ts) turns them into Cloud API requests. Keeping them as data lets the
// conversation logic be tested by simply looking at what it returns.
//
// WhatsApp limits (Meta docs, Oct 2026) are enforced HERE, so a long service or business name can
// never make WhatsApp reject a message:
//   reply buttons: max 3, title <= 20 chars (unique), id <= 256, body <= 1024, footer <= 60
//   list: <= 10 rows in total, row title <= 24, row description <= 72, row id <= 200,
//         button label <= 20, section title <= 24, body <= 4096, footer <= 60

export interface Button {
  id: string;
  title: string;
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

export type Outbound =
  | { kind: "text"; body: string }
  | { kind: "buttons"; body: string; footer?: string; buttons: Button[] }
  | { kind: "list"; body: string; footer?: string; button: string; sectionTitle: string; rows: ListRow[] };

/** An alert to the business owner, sent as an approved template (outside the 24-hour window). */
export interface OwnerAlert {
  template: "rendo_nouveau_rdv" | "rendo_annulation_rdv" | "rendo_demande_contact";
  language: "fr";
  params: string[];
}

export const LIMITS = {
  buttons: 3,
  buttonTitle: 20,
  buttonId: 256,
  buttonsBody: 1024,
  footer: 60,
  rows: 10,
  rowTitle: 24,
  rowDescription: 72,
  rowId: 200,
  listButton: 20,
  sectionTitle: 24,
  listBody: 4096,
} as const;

/** Cuts text to `max` characters (counting emoji/accents as one), adding "…" when cut. */
export function fit(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, Math.max(0, max - 1)).join("").trimEnd() + "…";
}

export function text(body: string): Outbound {
  return { kind: "text", body: fit(body, LIMITS.listBody) };
}

export function buttons(body: string, items: Button[], footer?: string): Outbound {
  if (items.length < 1 || items.length > LIMITS.buttons) throw new Error("buttons: 1 to 3 buttons");
  const seen = new Set<string>();
  const safe = items.map((b) => {
    let title = fit(b.title, LIMITS.buttonTitle);
    while (seen.has(title)) title = fit(title, LIMITS.buttonTitle - 1) + "·"; // titles must be unique
    seen.add(title);
    if (b.id.length > LIMITS.buttonId) throw new Error("button id too long");
    return { id: b.id, title };
  });
  return {
    kind: "buttons",
    body: fit(body, LIMITS.buttonsBody),
    footer: footer ? fit(footer, LIMITS.footer) : undefined,
    buttons: safe,
  };
}

export function list(body: string, button: string, sectionTitle: string, rows: ListRow[], footer?: string): Outbound {
  if (rows.length < 1 || rows.length > LIMITS.rows) throw new Error("list: 1 to 10 rows");
  return {
    kind: "list",
    body: fit(body, LIMITS.listBody),
    footer: footer ? fit(footer, LIMITS.footer) : undefined,
    button: fit(button, LIMITS.listButton),
    sectionTitle: fit(sectionTitle, LIMITS.sectionTitle),
    rows: rows.map((r) => {
      if (r.id.length > LIMITS.rowId) throw new Error("row id too long");
      return {
        id: r.id,
        title: fit(r.title, LIMITS.rowTitle),
        description: r.description ? fit(r.description, LIMITS.rowDescription) : undefined,
      };
    }),
  };
}
