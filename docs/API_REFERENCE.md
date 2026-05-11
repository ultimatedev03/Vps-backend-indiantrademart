# IndianTradeMart Backend API Reference (Vendor & Buyer)

This document summarises all REST APIs exposed by the backend that are relevant to the Vendor and Buyer applications. It also lists public Directory endpoints used by the Buyer app. Internal Admin/Employee/Finance APIs are catalogued briefly at the end.

Base URL
- Local dev: http://localhost:3001
- All endpoints are under the `/api` prefix.

Authentication
- Session: HTTP-only cookie set by `POST /api/auth/login` or `POST /api/auth/register`.
- Bearer: You may send `Authorization: Bearer <token>` instead of cookies.
- CSRF: For non-GET requests when using cookie auth, include header `x-csrf-token` with the CSRF cookie value.
- Roles: `BUYER` and `VENDOR` sessions are strictly isolated; cross-portal access is blocked.

---

## Auth

- POST /api/auth/login
  - Purpose: Login for Buyer or Vendor.
  - Body: `{ email, password, role?: 'BUYER'|'VENDOR' }`
  - Response: `{ success: true, user: { id, email, role, access_token, ...buyer flags when applicable } }`
  - Notes: Sets session cookies. If `role='BUYER'`, email must belong to a registered buyer and not a vendor.

- POST /api/auth/register
  - Purpose: Register a new user (supports Buyer creation when `role='BUYER'`).
  - Body: `{ email, password, full_name?, role: 'BUYER'|'USER'|'VENDOR', phone?, no_session? }`
  - Response: `{ success: true, user, session_skipped? }`

- GET /api/auth/me
  - Purpose: Get current session + user payload.
  - Response: `{ user: { id, email, role, access_token, ... }, buyer: {...}|null }`

- PATCH /api/auth/password
  - Purpose: Update logged-in user password.
  - Headers (cookie auth): `x-csrf-token`
  - Body: `{ current_password?, new_password }`
  - Response: `{ success: true, auth_password_synced: boolean }`

- POST /api/auth/logout
  - Purpose: Clear auth cookies.
  - Response: `{ success: true }`

### OTP & Password Reset
- POST /api/otp/request — `{ email }` → `{ success, otp (dev), expiresAt }`
- POST /api/otp/verify — `{ email, otp_code }` → `{ success, email }`
- POST /api/otp/resend — `{ email }` → `{ success, otp (dev), expiresAt }`
- POST /api/password-reset — `{ email, new_password }` → `{ success, role, auth_password_synced }`
- POST /api/password-reset/verify-email — `{ email, role: 'BUYER'|'VENDOR' }` → `{ success, found, role }`

---

## Buyer APIs

- GET /api/auth/buyer/profile
  - Auth: BUYER
  - Response: `{ success: true, buyer: {...}, account_status, user }`

- PATCH /api/auth/buyer/profile
  - Auth: BUYER, CSRF when cookie auth
  - Body: Partial updates of buyer columns, e.g. `{ full_name?, phone?, address?, state_id?, city_id?, ... }`
  - Response: `{ success: true, buyer, user }` (session refreshed when applicable)

- POST /api/auth/buyer/profile/avatar
  - Auth: BUYER, CSRF when cookie auth
  - Body: `{ data_url (base64), content_type?, file_name? }`
  - Response: `{ success: true, publicUrl }`

### Buyer Quotations & Messaging
Base: `/api/quotation`
- GET /api/quotation/received — Buyer quotations list.
- GET /api/quotation/received/:quotationId — Quotation detail.
- GET /api/quotation/unread-count — Unread chat count.
- GET /api/quotation/:proposalId/messages — Messages list for a proposal.
- POST /api/quotation/:proposalId/messages — Send a message `{ text, attachments? }`.
- PATCH /api/quotation/:proposalId/messages/:messageId — Edit message.
- DELETE /api/quotation/:proposalId/messages — Bulk delete by IDs.
- DELETE /api/quotation/:proposalId/messages/:messageId — Delete one.
- POST /api/quotation/messages/ack-delivered — Ack delivery for message IDs.

Typical responses: `{ success: true, items|messages|count|... }`. All require auth.

### Notifications (Buyer & Vendor)
Base: `/api/notifications`
- GET /api/notifications — List notifications. Query `limit?` (default 100).
- GET /api/notifications/unread-count — Returns `{ success: true, count }`.
- POST /api/notifications/read-all — Mark all as read.
- PATCH /api/notifications/:id/read — Mark one as read.
- DELETE /api/notifications/:id — Delete one.
- Bulk variants: `GET /list`, `PATCH /read`, `DELETE /` with `{ ids: [] }`.

---

## Vendor APIs

Base: `/api/vendors`

- GET /api/vendors/me — Current vendor profile.
- PUT /api/vendors/me — Update vendor profile. Body: vendor fields (PAN/GST/etc. validated).

Bank Details
- GET /api/vendors/me/banks — List bank details.
- GET /api/vendors/me/banks/:bankId — Get one.
- POST /api/vendors/me/banks — Create. Body: `{ account_holder, bank_name, branch_name, account_number, ifsc_code, is_primary? }`
- PUT /api/vendors/me/banks/:bankId — Update (partial accepted).
- DELETE /api/vendors/me/banks/:bankId — Delete.

KYC & Documents
- POST /api/vendors/me/kyc/submit — Submit KYC; locks docs when approved.
- GET /api/vendors/me/documents — List documents.
- GET /api/vendors/me/documents/:docId — Get document meta.
- POST /api/vendors/me/documents — Upload document. Body supports base64 or storage path.
- DELETE /api/vendors/me/documents/:docId — Delete one.
- DELETE /api/vendors/me/documents — Bulk delete by IDs.

Media Uploads
- POST /api/vendors/me/upload — Upload image/media. Body: `{ data_url, content_type, bucket }`. Uses Cloudinary if configured, else Supabase Storage.

Leads & Proposals
- GET /api/vendors/me/marketplace-leads — Marketplace leads list (with filters & vendor scope).
- POST /api/vendors/me/leads/:leadId/purchase — Purchase/unlock a lead.
- GET /api/vendors/me/leads — Vendor leads list (owned/purchased).
- GET /api/vendors/me/leads/:leadId — Lead detail.
- GET /api/vendors/me/leads/:leadId/contacts — Lead contacts.
- POST /api/vendors/me/leads/:leadId/contacts — Add a contact note.
- GET /api/vendors/me/leads/:leadId/status-history — Status timeline.
- POST /api/vendors/me/leads/:leadId/status — Update status.
- GET /api/vendors/me/proposals — Vendor proposals list (sent/received filters via query).
- GET /api/vendors/me/proposals/:proposalId — Proposal detail.
- DELETE /api/vendors/me/proposals/:proposalId — Delete a proposal.

Public Vendor
- GET /api/vendors/:vendorId — Public vendor details by UUID.

### Vendor Quotations
Base: `/api/quotation`
- GET /api/quotation/sent — Vendor dashboard list of sent quotations.
- POST /api/quotation/send — Send quotation to a buyer via email and create a proposal record.
  - Body (key fields):
    ```json
    {
      "quotation_title": "Product ABC",
      "quotation_amount": 15000,
      "quantity": "10",
      "unit": "kg",        // merged into quantity for storage
      "validity_days": 7,
      "delivery_days": 3,
      "terms_conditions": "Net 30",
      "buyer_email": "buyer@example.com",
      "vendor_id": "<vendor-uuid>",
      "vendor_name": "Owner Name",
      "vendor_company": "Company Pvt Ltd",
      "vendor_phone": "9876543210",
      "vendor_email": "vendor@example.com",
      "attachment_name": "quote.pdf",      // optional
      "attachment_base64": "...",          // optional
      "attachment_mime": "application/pdf" // optional
    }
    ```
  - Response: `{ success: true, quotation_id, buyer_registered }`

---

## Payments (Vendor)
Base: `/api/payment`

Subscriptions
- POST /api/payment/initiate — Create Razorpay order for plan.
  - Body: `{ vendor_id, plan_id, coupon_code? }`
  - Response: `{ success, order: { id, amount, currency, ... }, payable_amount, discount? }`
- POST /api/payment/verify — Verify Razorpay payment and create subscription.
  - Body: `{ order_id, payment_id, signature, vendor_id, plan_id, coupon_code? }`
  - Response: `{ success, subscription_id, invoice_id }`
- GET /api/payment/history/:vendor_id — Payment history for a vendor.
- GET /api/payment/invoice/:payment_id — Download invoice PDF. Query `refresh=true` to regenerate.
- GET /api/payment/invoice/by-tx/:transaction_id — Fetch/regenerate invoice by transaction/payment id.
- GET /api/payment/plans — Active subscription plans.
- GET /api/payment/referral-offers/:vendor_id — Referral discount preview per plan.

Lead Purchases
- POST /api/payment/lead/initiate — Razorpay order for lead purchase. Body: `{ lead_id }`
- POST /api/payment/lead/verify — Verify lead payment and unlock the lead.

---

## Public Directory (Buyer-facing)
Base: `/api/dir`

Search & Products
- GET /api/dir/search — Ranked product search. Query: `q, stateId?, cityId?, microId? ...`
- GET /api/dir/products — Same as search, legacy alias.
- GET /api/dir/product/:slug — Product by slug.
- GET /api/dir/product/id/:productId — Product by ID/UUID.
- GET /api/dir/products/list — Listing with filters. Query: `microId, q, stateId, cityId, vendorId, sort?, limit?, page?`

Locations
- GET /api/dir/states — List of states.
- GET /api/dir/cities?stateId= — Cities by state.

Categories
- GET /api/dir/head-categories — Top categories.
- GET /api/dir/sub-categories?headId= — Subs by head.
- GET /api/dir/micro-categories?subId= — Micros by sub.
- GET /api/dir/categories — Flat list (head level).
- GET /api/dir/hierarchy — Full 3-level hierarchy.
- GET /api/dir/categories/home-showcase — Home showcase data.
- GET /api/dir/categories/children?parentId=&parentType=SUB|HEAD — Children of a category.
- GET /api/dir/categories/top-level — Top-level categories.
- GET /api/dir/categories/head-count — Count of active heads.
- GET /api/dir/category/:type/:slug — Generic by type (head|sub|micro) and slug.
- GET /api/dir/category/universal/:slug — Auto-resolve by slug.

Vendors
- GET /api/dir/vendor/:vendorSlug — Public vendor profile by slug.
- GET /api/dir/vendors/search?q= — Search vendors.
- GET /api/dir/vendors/detail/:vendorId — Vendor detail by UUID.
- GET /api/dir/vendors/:vendorId/ratings — Ratings summary.

Leads (Public Read-only)
- GET /api/dir/leads/public — Public lead listings. Query supports `microId, stateId, cityId, q, ...`

Contact
- POST /api/dir/contact — Public contact form.
  - Body: `{ name, email, phone, message, company? }`
  - Response: `{ success: true }`

---

## Referrals (Vendor)
Base: `/api/referrals` (all require VENDOR auth)
- GET /api/referrals/me — Wallet, profile, rules, referrals, ledger.
- POST /api/referrals/link — Link referred vendor: `{ referral_code }`.
- GET /api/referrals/cashouts — List cashout requests.
- POST /api/referrals/cashout — Create cashout: `{ amount, bank_detail_id?, note? }`.

---

## Internal (summary only)
These are for Admin/Employee/Finance dashboards and are not used by Vendor/Buyer portals directly. Consult the source files for details:
- /api/admin → `server/routes/admin.js`
- /api/superadmin → `server/routes/superadmin.js`
- /api/employee → `server/routes/employee.js`
- /api/data-entry → `server/routes/dataEntry.js`
- /api/territory → `server/routes/territory.js`
- /api/support → `server/routes/supportTickets.js`
- /api/finance → `server/routes/finance.js` (coupons, referral rules, finance summaries)
- /api/kyc → `server/routes/kyc.js` (KYC review workflows)
- /api/migration → `server/routes/migration.js` (data migration utilities)
- /api/chat → `server/routes/chatbot.js` (AI chatbot)

---

Testing tips
- For cookie sessions, include `x-csrf-token` on mutating requests.
- Prefer Bearer token in API clients (Postman) to avoid CSRF header handling.
- Rate limits: global `/api/*` limiter, plus stricter `/api/auth` and `/api/otp` per IP.
