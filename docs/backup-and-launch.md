# Backup, recovery and launch readiness

## Encrypted export
Admin → Access → Encrypted backup. Enter a new high-entropy passphrase (at least 20 characters), repeat it and reauthenticate. The server reads the persisted state, encrypts it with scrypt and AES-256-GCM, and returns only the encrypted envelope. Keep the passphrase separately. The export includes business records and salted credential hashes, potentially personal data, not environment variables or API keys. There is no background backup and no public restore endpoint.

Offline recovery on a trusted computer with the repository and Node.js:
```bash
read -rs -p 'Backup passphrase: ' FD_BACKUP_PHRASE; echo
printf '%s' "$FD_BACKUP_PHRASE" | node scripts/decrypt-backup.js backup.encrypted.json recovered-state.json
unset FD_BACKUP_PHRASE
```
The tool refuses to overwrite an existing output. The decrypted file is sensitive. Do not commit, upload to a public folder, paste into chat, or point it at the current running database. Verify the file and test restore in an isolated environment before a planned migration. Rotate credentials if any compromise is suspected. Store encrypted backups in separate locations, with retention and access controls. Do not retain them indefinitely.

## Database continuity
The existing Render free PostgreSQL instance has a finite expiry. Confirm the exact expiry in the dashboard; it was 2026-12-16 when checked. An exported backup does not keep the live database available after expiry. Before expiry, choose a durable destination and confirm costs, limits, processor terms and processing region. Plan a maintenance window, stop writes, export and validate the current snapshot, restore to an isolated destination, compare record counts, update DATABASE_URL privately, verify health and workflows, and make a rollback plan. Never set ALLOW_EMPTY_PRODUCTION_STATE=true simply to bypass a migration failure. No migration or service upgrade has been performed by this change.

## Move to another PostgreSQL database without overwriting existing data

As of 2026-11-18, Render reports that the current Free Postgres instance `fair-delivery-pilot-db` is available and expires on **2026-12-16T20:05:35Z**. Never rely on its paid upgrade grace period to preserve new orders. Avoid switching the live database merely by replacing `DATABASE_URL` while the existing app is writing; that would lose changes made after the export.

A possible long-term Free option is Neon PostgreSQL, provided the owner opens a Free plan in an appropriate region, reviews current free-usage limits and its DPA, and connects the provider or supplies its connection privately. Neon Free plan capacity is not a production SLA. Be aware of geographic distance between the current Render Oregon web instance and a European database.

**Preparation (no production changes):**

1. Decide on a durable PostgreSQL destination, region and retention policy. Keep the current Render database and service untouched.
2. On the existing Admin **Access** tab, select **Έλεγχος αποθήκευσης**. Record the date, row counts and integrity SHA-256 in a secure operator log.
3. Create a fresh encrypted Admin backup. Download and verify the encrypted file before doing anything to the current service. The passphrase must be held separately and not pasted into chat or committed.
4. On a trusted computer with the Fair Delivery repository and Node.js available, run a **dry run**:
   ```bash
   read -rs -p 'Backup passphrase: ' FD_BACKUP_PHRASE; echo
   printf '%s' "$FD_BACKUP_PHRASE" | node scripts/import-encrypted-backup.js backup.encrypted.json --dry-run
   unset FD_BACKUP_PHRASE
   ```
   The command shows a digest and record counts, creates no plaintext file and connects to no database. Compare with the Admin report. Stop if values differ.

**Copy to an empty destination (not production cut-over):**

5. Create a **new and empty** PostgreSQL database. Use the connection details **privately** on a trusted computer, not in GitHub or chat. Configure `FD_NEW_DATABASE_URL` to the destination, separate from the existing `DATABASE_URL`. TLS is required by the destination provider.
6. With the export still fresh, run the import only after verifying the destination is the new empty database:
   ```bash
   read -rs -p 'Backup passphrase: ' FD_BACKUP_PHRASE; echo
   export FD_MIGRATION_CONFIRM=IMPORT_INTO_EMPTY_DB
   printf '%s' "$FD_BACKUP_PHRASE" | node scripts/import-encrypted-backup.js backup.encrypted.json --apply
   unset FD_BACKUP_PHRASE FD_MIGRATION_CONFIRM FD_NEW_DATABASE_URL
   ```
   This script refuses Render destinations and existing records, wraps the insert and verification in a transaction, and will not change the production Render environment. If any step fails, the original database remains untouched. The import output includes only counts and a SHA-256 digest, not user data.

**Actual cut-over (separate deliberate operation):**

7. Schedule a controlled maintenance window and **stop all writes to the old service**. Merely showing the pilot UI a banner is not sufficient; the HTTP order and account endpoints must be blocked or the service must be taken offline while the export is generated.
8. Produce a **new final snapshot** after writes stop. Do not switch to an earlier snapshot that may miss changes. If the empty destination already contains an earlier test import, create another fresh empty destination, or perform a separately approved and verified restore under maintenance. The safe import tool never overwrites.
9. Validate counts and SHA-256, then import the final snapshot. Check data consistency before switching `DATABASE_URL`. Record the new connection only in Render private environment.
10. Bring the service up and verify database connectivity, Admin **Έλεγχος αποθήκευσης**, customer/shop/rider login, pilot menus, account records, order history and settlement views. If anything fails, return to the old URL under maintenance and reconcile writes carefully.
11. Only after a satisfactory retention and backup policy, privacy/processor review, verified commercial safeguards and actual operator approval consider activating real accounts or commerce.

**Known operational constraints:** the current JSONB single-row architecture is intended for a small pilot, not a concurrent commercial marketplace. A durable PostgreSQL provider by itself does not create high availability, an automatic backup schedule, verified delivery of email, monitoring or legal compliance. The existing `render.yaml` no longer declares an automatic dependency on the expiring Render Free Postgres; `DATABASE_URL` remains privately configured in Render. This change **does not migrate data automatically**.

## Customer accounts
Pilot aliases only. A logged-in user can generate a single-use recovery code after reauthentication; only its hash is stored. New codes replace older codes; password rotation and successful recovery revoke sessions and recovery codes. This is not email identity verification, not a commercial customer signup process, and not a substitute for verified email/contact and reviewed retention.

## Remaining gates for commercial launch
- Durable database, tested restores, monitoring, operational capacity, and explicit backup schedule.
- Verified owner/business details, complete privacy notice, processor/transfer review, rights process and retention for customers, store representatives and couriers.
- Actual store agreements, lawful customer payment options, receipts/tax invoicing and reviewed fixed fee treatment.
- Verified email signup/recovery, secure order data retention and customer support/cancellation/refund processes.
- Test on actual phones/tablets, including background notification limits. The shop sound/count works in the foreground only.
- Keep commercial orders and full real applications disabled until the responsible operator approves and verifies these gates. No payment processor, real transaction or automatic freelancer dispatch is enabled.
