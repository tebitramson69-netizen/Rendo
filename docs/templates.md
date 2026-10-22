# WhatsApp message templates (source of truth)

Templates are needed for any message sent **outside the 24-hour window** after the client's last message
(reminders, owner alerts). Meta reviews each one (usually minutes, up to 24 h).

Rules followed (Meta / BSP guidelines):
- Category **Utility** (transactional, no promotion, no "offer", "discount", "new", emojis kept out).
- Never start or end the body with a variable; variables numbered `{{1}}`, `{{2}}`… in order, each surrounded by explanatory text.
- Every variable has a sample value (review runs on the rendered preview).
- Quick-reply labels ≤ 25 characters; footer ≤ 60 characters, no variables.
- No health information: only the business name, the service label chosen by the business, date/time and a booking code.

> Templates belong to a WhatsApp Business Account (WABA). The ones created now live in the **test WABA**
> (`1767371018729362`) for testing reminders with the test number. When the pilot moves to a real number
> (Production setup), re-create them in that WABA by copying this file.

---

## 1. `rendo_rappel_rendez_vous` — client reminder (fr + en)

Sent ~24 h before the appointment. The booking id travels in each quick-reply button's **payload**
(set by our code at send time), so the code doesn't need to appear in the text. Taps come back to the
webhook as `button.payload` (handled in M4).

**French (`fr`)**

| Part | Content |
|---|---|
| Body | `Bonjour {{1}}, nous vous rappelons votre rendez-vous chez {{2}} prévu le {{3}}. Merci de confirmer votre présence ou d'annuler en appuyant sur un des boutons ci-dessous.` |
| Footer | `Rendo · prise de rendez-vous` |
| Quick reply 1 | `Je confirme` |
| Quick reply 2 | `Annuler` |
| Samples | {{1}} `Marie` · {{2}} `Studio Belle Vie` · {{3}} `jeudi 23 octobre à 10h30` |

**English (`en`)** — same template name, second language

| Part | Content |
|---|---|
| Body | `Hello {{1}}, this is a reminder of your appointment at {{2}} on {{3}}. Please confirm your attendance or cancel by tapping one of the buttons below.` |
| Footer | `Rendo · appointment booking` |
| Quick reply 1 | `I confirm` |
| Quick reply 2 | `Cancel` |
| Samples | {{1}} `Marie` · {{2}} `Studio Belle Vie` · {{3}} `Thursday 23 October at 10:30` |

> **History:** v1 `rendo_rappel_rdv` (fr) was **rejected on 20 Oct 2026 — "Category is incorrect"**
> (`INCORRECT_CATEGORY`). Most likely trigger: "Code de réservation : {{4}}" with a short sample (`R4821`)
> looks like a one-time login code (Authentication category). v2 removes the code from the text and uses a
> new name, because a rejected template can't be edited.

## 2. `rendo_nouveau_rdv` — owner: new booking (fr)

| Part | Content |
|---|---|
| Body | `Nouveau rendez-vous enregistré par Rendo. Client : {{1}}. Prestation : {{2}}. Date : {{3}}. Téléphone : {{4}}. Référence : {{5}}. Ce créneau est maintenant bloqué dans votre planning.` |
| Footer | `Rendo · prise de rendez-vous` |
| Buttons | none |
| Samples | {{1}} `Marie Ngo` · {{2}} `Coupe et brushing` · {{3}} `jeudi 23 octobre à 10h30` · {{4}} `+237 690 00 00 00` · {{5}} `R4821` |

## 3. `rendo_annulation_rdv` — owner: cancellation (fr)

| Part | Content |
|---|---|
| Body | `Un rendez-vous a été annulé. Client : {{1}}. Prestation : {{2}}. Date : {{3}}. Référence : {{4}}. Ce créneau est de nouveau disponible pour d'autres clients.` |
| Footer | `Rendo · prise de rendez-vous` |
| Buttons | none |
| Samples | {{1}} `Marie Ngo` · {{2}} `Coupe et brushing` · {{3}} `jeudi 23 octobre à 10h30` · {{4}} `R4821` |

---

## Status

| Template | Language | Submitted | Status |
|---|---|---|---|
| rendo_rappel_rdv (v1) | fr | 20 Oct 2026 | Rejected — incorrect category |
| rendo_rappel_rendez_vous (v2) | fr | 21 Oct 2026 | Approved (Active) |
| rendo_rappel_rendez_vous (v2) | en | 22 Oct 2026 | In review |
| rendo_nouveau_rdv | fr | 22 Oct 2026 | In review |
| rendo_annulation_rdv | fr | 22 Oct 2026 | In review |

> Language codes our code must send: French = `fr`, English = `en` (plain "English", not en_US / en_GB).
