# Verified customer email foundation

The public email registration, login and password-reset routes are **closed by default**. The existing demo accounts continue to work. A verified email account is not authorized to place real or pilot orders.

The optional transactional transport uses Brevo's HTTPS API. The Free plan currently offers up to 300 sends per day; Fair Delivery enforces its own persisted daily cap of 50 and per-address cooldown. No paid fallback. See https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan and https://developers.brevo.com/reference/send-transac-email.

Before opening:
1. Create and confirm a free provider account, register a verified sender and authenticate the sending domain as needed. Verify deliverability and sender requirements; a free mailbox is not necessarily a valid production sender.
2. Review processor agreements, transfers, retention, and the handling of confirmation emails. Do not use the transactional API for marketing.
3. Migrate to durable, approved storage and verify backups and restore.
4. Publish a reviewed privacy notice identifying the controller, purpose, legal basis, recipients, retention, rights, complaint procedure and contact.
5. Configure BREVO_API_KEY, BREVO_SENDER, FD_BREVO_FREE_CONFIRMED, FD_CUSTOMER_EMAIL_CONTROLLER, FD_CUSTOMER_EMAIL_CONTACT, FD_CUSTOMER_EMAIL_NOTICE, and FD_CUSTOMER_STORAGE_APPROVED as private server settings. The owner must review and explicitly enable FD_CUSTOMER_EMAIL_OPEN=true only when the prerequisites are met.
6. Test actual delivery with an authorized test mailbox, then review the full workflow on devices before opening registration. No provider account or API key is created by this PR.

Verification uses a cryptographically random 32-byte single-use token. Only the token hash and hashed email lookup are kept in a short-lived challenge. Successful signup stores the verified email and privacy acknowledgment version; password reset rotates credentials and revokes sessions. Codes expire after 20 minutes, with expired challenge cleanup at startup and periodically. The real order gate remains closed. The end-to-end tests use a local synthetic mail stub and do not send email or create accounts on the deployed platform.
