# Document changes raised while building

Rule (Section 1.3): if something is unclear or missing, raise it as a document change instead of guessing in
code. Each item below says what was unclear and what the code does until the document answers.

| # | Where | Question | What the code does now |
|---|-------|----------|------------------------|
| 1 | Section 17A | The mobile-app tab (GR-40–49, P-59, CFG-182–188, MOB-01–10, NFR-16–18, DEC-26–30) is not in the exported document. | Nothing app-specific is built yet. |
| 2 | P-02 backend rules | "Short-lived access token" has no number. | 5 minutes (src/config/technical.ts). Every request re-checks the session anyway. |
| 3 | P-03 | Parallel browser tabs refreshing the session at the same moment. | The previous refresh token is accepted for 30 seconds after rotation; any later reuse ends the session. |
| 4 | P-04 | How long may step 3 (new number) take after the current number is verified? | CFG-02 (5 minutes), bound to the same session. |
| 5 | CFG-83 | How long is a step-up OTP valid, and which actions need it? | Single use, for one named action, valid CFG-02. Actions: APPROVE, PUBLISH, PLAN_CHANGE, CONFIG_CHANGE, SUPPORT_GRANT. |
| 6 | P-01 / CFG-78 | Does the 7-day trial include the registration day? | Yes: periodStart = registration day (IST), periodEnd = start + CFG-78 − 1. |
| 7 | CFG-05 | Is the send limit per mobile for all purposes together? | Yes, all purposes together; reaching it locks sending for CFG-06 (AUTH-06). |
| 8 | CFG-10 | Which requests count as "registration and login requests"? | Send OTP and Verify, for register and login. |
| 9 | P-01 step 5c | AUTH-08 is shown only after the OTP is verified, so an SMS is spent. | As written. Could be checked before sending, if preferred. |
| 10 | P-02 | No message ID for an ordinary successful login. | No message shown; the home screen opens. |
| 11 | P-03 | No message ID for the end of the longest session (CFG-08). | GEN-09. |
| 12 | P-02 | No message for a disabled Advisor or Assistant. | AUTH-11. |
| 13 | P-01, P-04 | SMS wording and DLT template IDs [TO CONFIRM]. | MSG91 template variables `##otp##`, `##minutes##`; mobile-changed notice `##mobile##`. |
| 14 | CFG-82 | Plan prices [TO CONFIRM]. | Website shows "Price to be announced". |
| 15 | Section 21 | Some message texts had line-break artefacts in the PDF export (for example "{CFG- 123}"). | Corrected in messages.json; worth fixing in the source document. |
| 16 | Section 4.3 vs P-01 | Section 4.3 says the new TRIAL has "Plan NORMAL"; P-01 says "no plan chosen". | No plan (plan empty) during the trial, as P-01 says; the trial features come from CFG-173. |
| 17 | FLD-30 | An 11-digit number starting with 0 can be a landline (080 2345 6789) or a mobile with a leading 0. | Treated as a landline in phone fields; mobile-number fields (FLD-01) still accept the leading 0. |
| 18 | P-05 | The Business section carries a weight (CFG-124: 10) but none of its fields is "required for completion". | The section counts once "Name shown on quotations" is saved. |
| 19 | P-05 | "Alternate mobile: not the same as login mobile" has no message ID. | AUTH-24 ("This is already your registered number."). |
| 20 | P-07 | Same insurer and agent code in two accounts: who reviews the flag, and where? [TO CONFIRM DEC-09] | Both entries are flagged in the database; the SkyUp review screen comes with Section 17 admin tools. |
| 21 | GR-32 | The phone's PDF viewer cannot send the app's sign-in header when opening a file link. | A file link is bound to the user, their session and the file, and opens only while that session is active (CFG-07, CFG-08) and for CFG-31 minutes. |
| 22 | P-08 / P-09 | Dashboard counts and global search need leads, customers, quotations, policies and renewals. | Built with those modules (Phases 4–5). Phase 2 has banners, today's tasks, recent activity and the profile card. |
| 23 | P-06 | Working days for the KYC review target (CFG-125): are public holidays excluded? | Monday to Friday; holidays are not excluded until a holiday list is given. |
| 24 | P-20 to P-25 | Approvals need a second ADM, but adding SkyUp users (P-48) arrives with Section 17 (Phase 6). | `npm run seed` creates a second admin from SEED_SECOND_ADMIN_MOBILE. |
| 25 | P-21 | No message ID for a duplicate insurance type name. | VAL-22 on the name field. |
| 26 | CFG-83 / CFG-05 | Every approval sends a step-up OTP, and CFG-05 allows 5 sends per mobile per hour, so an approver is locked after 5 approvals in an hour. | As written (all purposes count together, item 7). Suggest excluding STEP_UP from CFG-05, or one OTP per approval session. |
| 27 | P-23 | Which OCR provider reads scanned brochures and photos? | Text PDFs are read on the server. Scanned PDFs and photos fail with OCR-03 and the values are entered by hand until a provider is chosen. |
| 28 | P-23 | How OCR confidence is worked out is not defined. | Exact feature name with a value of the right type: 95. Most words of the name: 70. No value: not found. Below CFG-37 is highlighted. |
| 29 | P-21 / P-24 | Band labels in rate tables. | A band is written "18-35" in the CSV and the grid; en dashes are accepted. |
| 30 | P-22 | No message ID for a successful save of an own product, or for a status change other than WITHDRAWN. | GEN-08 with the product name. |
| 31 | P-24 | No message ID for saving the first price (there is no current price to close). | GEN-08 ("Price V1 saved."). |
| 32 | P-25 step 1 | Approvals lists price versions, message templates and configuration changes. | Price versions need no approval (v3.1 note in P-24). Message templates and configuration changes join the list in Phase 6. |
| 33 | P-58 | Which fields can an advisor point at? | Name, description, UIN, ages, nominees, grace days, launch date, sum insured, terms, riders, tax, nominee rule, source link, and every template feature. Simple values are filled into the new draft; the rest are typed in by the reviewer. |
| 34 | P-12 / P-26 | "Dependent child" is not defined for family floater bands. | Son, daughter, grandson or granddaughter whose age is inside the child band of the product. |
| 35 | P-26 | Best fit needs fixed feature keys to score templates. | Keys room_rent, copay, ped_wait, csr, restore, network; a template without a key scores 0 for it. |
| 36 | P-26 | Products entered by hand (MANUAL_ENTRY) have no rate table. | Budget-fit score 0 for them; they still appear, ranked lower. |
| 37 | P-28 | May a quotation have a draft revision while a shared revision is still live? | Yes: at most one draft and one live revision at the same time (enforced by the database). |
| 38 | Section 3.2 vs P-27 / P-28 | The permission table does not let Assistants quote; the process sections do. | Assistants may create, share and revise quotations, as the process sections say. |
| 39 | P-29 / P-30 | No template exists for the comparison email. | A built-in plain-text email with the comparison link. |
| 40 | P-39 | Are the default templates usable before a SkyUp approval? | The released default set is seeded once: email templates ACTIVE; WhatsApp templates SUBMITTED_TO_META until the provider's webhook reports Meta's decision. Later edits go through maker-checker. |
| 41 | P-41 / P-42 | WhatsApp provider and webhook format are not named. | Provider-neutral: `WHATSAPP_PROVIDER=http` posts `{from,to,template,language,variables}`; status webhooks are signed with HMAC-SHA256 of the raw body in `x-signature`. |
| 42 | P-39 | No message ID for a duplicate template name. | CAT-07. |
| 43 | CFG-82 | Plan prices are still null. | Online plan payment shows "prices being finalised"; SkyUp records offline payments (P-51) meanwhile. |
| 44 | P-47 vs P-51 | P-47 has online checkout; P-51 says SkyUp records payments by hand. | Both are built: Razorpay checkout when prices and keys are set, and offline payment by an Admin with OTP. |
| 45 | P-47 | Upgrade credit for the unused part of a Normal plan is not defined. | Not built: no credit is given for the unused part of the current plan. |
| 46 | P-56 | Is a GST invoice issued for a wallet recharge? | No invoice for recharges until the document says so; the statement lists every recharge. |
| 47 | P-46 | Where is the referred person's WhatsApp consent stored? | In the new lead's notes with the date and mobile; consent on the customer is recorded at conversion. |
| 48 | P-51 / ADM-09 | ADM-09 needs a deletion date but CFG-87 keeps closed accounts indefinitely. | The message reads "never deleted automatically (CFG-87)". |
| 49 | P-13 | Identity documents: no OCR provider is named for reading PAN / Aadhaar photos. | Values are typed by hand; the image is stored and verified by a person. |
| 50 | P-47 / P-56 | How long to wait for the gateway before saying a payment failed. | CFG-180 minutes (30); the website reads it from /public-settings. |
