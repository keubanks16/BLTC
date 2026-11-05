# BLTC eMAR & Care

A caregiver / med-passer web app for assisted living: electronic MAR, med pass, PRNs, care plans built from assessments, shift task lists, custom care alerts, vitals, notes and reports. Works on phones, tablets and laptops, and can be added to the Home Screen.

## Features

**Med pass (eMAR)**
- Med pass by time window (Due now / Late / Morning / Noon / Evening / Bedtime), grouped by resident and room
- Resident photo, allergies, code status, diet and care alerts shown before every pass
- Check off meds and sign once; e-signature (initials) stamped on every dose by the server
- Refused / Held / Not available with reasons, who was notified, and an optional flag for the shift report
- Required vitals before certain meds (BP, pulse, blood sugar, O₂, temp, pain) with **hold parameters** (e.g. hold if SBP < 100)
- Late/early entries need a reason; flagged as late on the MAR
- Controlled substances: count entered with each dose, discrepancies auto-flagged, shift count with witness
- PRN: reason required, minimum interval and max per 24 h enforced (override needs a reason), effectiveness follow-up due after 60 min
- Strike entries made in error (with reason) — original stays in the record
- Inventory on hand + reorder alerts, "receive refill"

**MAR** — monthly grid per resident (initials / R / H / U / ✗ missed), printable, with staff signature legend

**Care plans & tasks**
- ADL assessment (bathing, dressing, toileting, mobility, eating, cognition, behaviors, night needs, fall/skin risk) → care level + **auto-generated task list**
- Shift task lists (Day / Evening / Night) with done / refused / N/A and notes
- Custom care alerts by resident, care level, or whole community

**Documentation** — vitals (abnormal values auto-flagged), progress / shift / incident / change-of-condition / behavior notes, resident status (LOA, hospital, discharged)

**Reports** — missed & late doses (gaps), refusals/holds, PRN use & follow-ups, reorder list, audit log; CSV export & print

**Staff** — PIN sign-in, roles: Caregiver · Med Tech · Nurse · Admin; auto-lock when idle; offline-tolerant (changes save when back online)

## Deploy (Cloudflare — shared by all staff)

The D1 database `bltc` is already created and wired in `wrangler.jsonc`.

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository**
2. Pick `keubanks16/bltc` → keep defaults → **Deploy**
3. Open the `*.workers.dev` URL → create the community name and first Admin PIN
4. More → Staff & PINs → add your caregivers and med techs

Every push to `main` redeploys automatically.

## Device mode

If the app is opened somewhere other than the Worker (e.g. GitHub Pages), it runs in **device mode**: everything is stored in that browser only. Good for demos/training; use the Cloudflare deploy for real use.

## Important

This app is not a certified medical record system and has no pharmacy integration. Before storing real resident health information, make sure your hosting and processes meet HIPAA requirements (including a Business Associate Agreement with your hosting provider) and your state's assisted-living medication documentation rules.
