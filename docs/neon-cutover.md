# Fair Delivery — Neon database cutover checklist (2026-11-18)

## Current verified infrastructure
- Existing app: Render web service `srv-dbgi9pu1egvs73b0oln0`, Oregon, currently in pilot mode.
- Existing state: Render PostgreSQL `fair-delivery-pilot-db`, **expires 2026-12-16 at 20:05:35 UTC**. Do not delete or reset.
- New destination prepared: Neon Free organization, project `fair-delivery-postgres`, ID `dawn-cherry-96999130`, AWS Frankfurt (`aws-eu-central-1`), database `fair_delivery`. The exact `fair_delivery_state` schema is present. At preparation time, **0 records** were present.
- Database URL values, API keys and backup passwords must remain only in private authorized configuration. Do not include them in repository, screenshots, chat, console logs, or URLs posted publicly.

## Stage 1 — safely prepare (no cutover)
1. Use **Admin → Πρόσβαση → Έλεγχος αποθήκευσης** to check that the existing database is reachable. Copy the SHA-256 and record counts to a private operator note. 
2. Use **Admin → Πρόσβαση → Κρυπτογραφημένο αντίγραφο ασφαλείας** with a separate strong passphrase; download the encrypted JSON file. Check that the file exists and keep the passphrase separately.
3. If using a trusted computer, test the encrypted file **offline** with:
   ```bash
   read -rs -p 'Backup passphrase: ' FD_BACKUP_PHRASE; echo
   printf '%s' "$FD_BACKUP_PHRASE" | node scripts/import-encrypted-backup.js backup.encrypted.json --dry-run
   unset FD_BACKUP_PHRASE
   ```
   Compare counts and SHA-256 to Admin. If inconsistent, stop.

## Stage 2 — freeze writes and create a FINAL snapshot
4. Set `FD_MAINTENANCE_MODE=true` in Render **without replacing existing environment variables**. Wait for the deploy to be live. This blocks order, account, shop, courier and settlement writes, while preserving Admin login, verification and encrypted backup. Existing clients may display a temporary maintenance error.
5. Generate and verify **another final encrypted backup** after the maintenance deploy is live. The previous copy is only a fallback. Keep both separately until after a successful cutover.
6. In Admin → Πρόσβαση → **Προετοιμασία μεταφοράς στη Neon**, click the preflight button. Check that the SHA-256 matches the **final** backup, the destination is empty, and maintenance is active. The destination will reject overwriting an existing record.
7. Confirm that you have a valid backup, enter the final digest and reauthenticate with Admin credentials, then click **Αντιγραφή μόνο στη νέα βάση**. The server copies the persisted JSONB state in a transaction, reads it back and checks the canonical SHA-256. The source is not changed. Do not repeat to an occupied database.

## Stage 3 — controlled cutover (separate operator approval)
8. Verify the imported record count on the new Neon database and the digest shown in Admin after copy. Do not add actual users or orders while in maintenance.
9. Change **only** `DATABASE_URL` in the Render service to the **private new Neon URL**. Keep `FD_MAINTENANCE_MODE=true` for the first deploy. The existing `render.yaml` uses `DATABASE_URL: sync:false` so Blueprints should not overwrite the connection during sync.
10. Confirm that the new Render deploy becomes live and `/api/health` reports PostgreSQL. Reauthenticate to Admin and verify stored record counts, menus, fees, shop/rider access and order history, using existing test records rather than adding new data. Confirm Neon has a `fair_delivery_state` row. If any check fails, remain in maintenance and return to the old Render database before allowing writes.
11. Only after successful checks, set `FD_MAINTENANCE_MODE=false` and confirm another live deploy. Keep the old Render database available for a rollback window; any new writes after cutover will need explicit reconciliation on rollback.

## Alternative offline CLI
An encrypted export can be copied into an **empty Neon database only** with `scripts/migrate-backup-to-neon.js`. This requires `NEON_MIGRATION_DATABASE_URL` set privately, a passphrase on standard input, a dry run, and `--apply --confirm-digest=<verified 64-character digest>`. The script verifies an empty destination, re-reads JSONB state after import, and never updates the live Render connection. It does not replace Stage 2 maintenance and final backup.

## Remaining business/legal gates
The destination being in Frankfurt is not proof that all processing stays in the EU: the current Render web service is in Oregon, and some external providers may process data outside the EEA. Review all DPAs, international transfers, lawful basis, controller identity, retention, customer notices, merchant terms and courier agreements with a qualified professional before collecting real personal data. Neon Free has usage limits, scale-to-zero and no guaranteed production SLA. The current state format is a single JSONB record and does not solve concurrent multi-instance writes. Real payments and verified commercial signups remain off until separately authorized.

**Do not claim migration is complete until the source and final Neon digest are verified and the Render `DATABASE_URL` cutover has been observed live.**
