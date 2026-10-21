# Upgrade progress (2026-10-21)

Durable log so the work can resume. Details: `upgrade-2026-10.md` (technical), `yangilanish-uz.md` (Uzbek).

## Decisions

- "Owner 1.14.3" does not exist: 1.14.3/1.14.4 are the server/client numbers; the Owner application was 1.7.0 → 1.8.0.
- `tv.exe` did not exist (the TV was a web page): added as a fifth shell kind (`PANEL_KIND=tv`) of the existing thin shell.
- Reused: control plane (customers, licences, devices, policy, signed grants, offline lease), receipt designer,
  stock ledger, queue page, shells. New code only where a requirement had no home.
- Trial = `ControlLicense.trialHours` + `trialStartedAt`; the licence end is an exact timestamp, grants are capped by it.
- Network rule applies to self-hosted installs only (cloud tenants are internet-facing by design).
- "exe" in the report requirement = Excel `.xlsx`.
- Existing deployed installs are never switched to a trial; they appear as `PENDING` registrations for Owner mapping.

## Done (commits on `main`)

1. Kitchen accept/reject + Oshxona shell + LAN auto-connect (`072a184`).
2. Report exports (xlsx/docx/pdf), layout, preview (`7997d74`).
3. Inventory alerts (`d79d3a4`).
4. TV application + read-only display role.
5. Local-network-only operation + Owner exception.
6. Registry: registrations, Owner events, exact-hour trial, assignment; Owner UI tabs; licence screen trial hours.

## Verified

Automated: backend integration suite (see test log in the delivery folder), type checks, Prettier.
Real applications on one PC: server + Admin + Kassa + Oshxona + TV page (`three-exe-e2e`), LAN discovery.

## Blockers / pending

- Two-computer Wi-Fi test, real HDMI monitor, Android devices.
- APKs (`ofitsiant.apk`, `tv.apk`) not rebuilt; Android TV not implemented.
- Installers unsigned (no certificate); Render deploy happens on push to `main`.
