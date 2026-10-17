// Plain types shared by Edge Functions and tests.
// This file must not import anything, so tests that use it never need to download packages.

/** Result of recording a WhatsApp message id: "duplicate" if Meta already delivered it. */
export type ClaimResult = "new" | "duplicate" | "error";
