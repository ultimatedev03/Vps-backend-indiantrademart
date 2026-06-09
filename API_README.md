# IndianTradeMart API README

This document is for application developers integrating with the IndianTradeMart backend.
It lists the currently mounted API surface, grouped by business module, with a short purpose for each endpoint group.

## Base URLs

Production:

```text
https://api.indiantrademart.com
```

Same-origin deployment may also proxy API calls from:

```text
https://indiantrademart.com/api
```

Local development commonly uses:

```text
http://localhost:5000
```

## Authentication

The backend uses session cookies plus role-aware middleware. Some public endpoints do not require login.

Common roles:

```text
BUYER, VENDOR, SALES, SUPPORT, DATA_ENTRY, MANAGER, VP, ADMIN, SUPERADMIN, DEVELOPER
```

For browser clients, call the API with credentials enabled:

```js
fetch(url, {
  credentials: "include",
  headers: { "Content-Type": "application/json" },
});
```

Most JSON responses follow this shape:

```json
{
  "success": true,
  "data": {}
}
```

Errors generally return:

```json
{
  "success": false,
  "error": "Message"
}
```

## Mount Points

| Prefix | Module | Notes |
|---|---|---|
| `/api/auth` | Auth | Login, register, role switching, buyer profile, password |
| `/api/otp` | Auth | OTP request, verify, resend |
| `/api/password-reset` | Auth | Password reset by email |
| `/api/dir` | Directory | Public catalogue, search, categories, products, vendors |
| `/api/public` | Public config | Public system/page status |
| `/api/visitor` | Visitor tracking | Public website activity collection |
| `/api/vendors` | Vendor | Vendor portal and public vendor profile APIs |
| `/api/kyc` | KYC | KYC review and document workflow |
| `/api/referrals` | Referrals | Vendor referral wallet and cashout |
| `/api/buyer` | Buyer | Buyer RFQ, requirements, leads, feedback |
| `/api/buyers` | Buyer alias | Same buyer router alias |
| `/buyer`, `/buyers`, `/api`, `/` | Buyer legacy aliases | Compatibility mounts for buyer routes |
| `/api/quotation` | Quotation | Buyer-vendor quote messaging |
| `/api/category-requests` | Category requests | Vendor category requests and data-entry review |
| `/api/payment` | Payment | Subscription and lead payments, invoices |
| `/api/finance` | Finance | Finance dashboard, coupons, referrals cashout |
| `/api/employee` | Employee | Staff profile, sales, pricing, subscription requests |
| `/api/data-entry` | Data entry | Internal CRUD for vendors, products, categories, locations |
| `/api/territory` | Territory | VP, manager, sales allocations and engagements |
| `/api/support` | Support and buyer alias | Support tickets plus buyer alias routes |
| `/api/admin` | Admin | Admin dashboard and operational controls |
| `/api/superadmin` | Superadmin | Owner console, plans, finance, god mode |
| `/api/notifications` | Notifications | In-app notification centre |
| `/api/chat` | Chatbot | AI assistant endpoint |
| `/api/db` | Database proxy | Controlled DB query bridge |
| `/api/migration` | Migration tools | One-time utility endpoints |
| `/uploads/*` | Static uploads | Uploaded files served from backend storage |
| `/health` | Health check | Backend health probe |

## Auth APIs

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | Public | Login buyer, vendor, employee, admin, or superadmin-compatible user. |
| POST | `/api/auth/register` | Public | Register a buyer/vendor account depending on payload role. |
| POST | `/api/auth/switch/buyer` | Vendor or buyer | Create or activate buyer mode for a vendor/user. |
| POST | `/api/auth/switch/vendor` | Buyer or vendor | Create or activate vendor mode for a buyer/user. |
| GET | `/api/auth/me` | Optional/session | Return current logged-in user and resolved role/profile. |
| GET | `/api/auth/buyer/profile` | Buyer | Return buyer profile for current buyer. |
| PATCH | `/api/auth/buyer/profile` | Buyer | Update buyer profile fields. |
| POST | `/api/auth/buyer/profile/avatar` | Buyer | Upload/update buyer avatar. |
| POST | `/api/auth/logout` | Session | Clear auth session/cookie. |
| PATCH | `/api/auth/password` | Logged in | Change current user password. |
| POST | `/api/otp/request` | Public | Request OTP for email/phone verification. |
| POST | `/api/otp/verify` | Public | Verify OTP code. |
| POST | `/api/otp/resend` | Public | Resend OTP code. |
| POST | `/api/password-reset` | Public | Start password reset flow. |
| POST | `/api/password-reset/verify-email` | Public | Verify email for password reset flow. |

## Public Directory APIs

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/dir/search` | Public | Ranked product search with query, category, city/state and pagination filters. |
| GET | `/api/dir/products` | Public | Product listing alias for ranked directory search. |
| GET | `/api/dir/products/list` | Public | Product list endpoint for marketplace pages. |
| GET | `/api/dir/products-preview` | Public | Preview products for micro-category/category cards. |
| GET | `/api/dir/product/:slug` | Public | Product detail by slug. |
| GET | `/api/dir/product/id/:productId` | Public | Product detail by UUID. |
| GET | `/api/dir/states` | Public | Active states for location filters. |
| GET | `/api/dir/cities` | Public | Active cities, optionally filtered by state. |
| GET | `/api/dir/head-categories` | Public | Active head categories. |
| GET | `/api/dir/sub-categories` | Public | Active sub-categories for a head category. |
| GET | `/api/dir/micro-categories` | Public | Active micro-categories for a sub-category, includes `image_url`. |
| GET | `/api/dir/categories` | Public | Flat public head category list. |
| GET | `/api/dir/categories/heads` | Public | Head category alias used by UI selectors. |
| GET | `/api/dir/categories/subs` | Public | Sub-category alias by head id. |
| GET | `/api/dir/categories/micros` | Public | Micro-category alias by sub id, includes `image_url`. |
| GET | `/api/dir/categories/home-showcase` | Public | Home page category hierarchy with heads, subs, micros and images. |
| GET | `/api/dir/categories/children` | Public | Children categories for a parent category. |
| GET | `/api/dir/categories/top-level` | Public | Top-level active categories. |
| GET | `/api/dir/categories/head-count` | Public | Count of active head categories. |
| GET | `/api/dir/hierarchy` | Public | Full 3-level category hierarchy. |
| GET | `/api/dir/search-micro` | Public | Micro-category search/typeahead. |
| GET | `/api/dir/micro-covers` | Public | Resolve micro-category cover images. |
| GET | `/api/dir/category/:type/:slug` | Public | Category detail by type and slug. |
| GET | `/api/dir/category/universal/:slug` | Public | Resolve head, sub, or micro category by slug. |
| GET | `/api/dir/vendor/:vendorSlug` | Public | Public vendor profile by slug/vendor id. |
| GET | `/api/dir/vendors/search` | Public | Public vendor search/listing. |
| GET | `/api/dir/vendors/detail/:vendorId` | Public | Vendor detail by UUID. |
| GET | `/api/dir/vendors/:vendorId/ratings` | Public | Vendor rating summary and recent reviews. |
| GET | `/api/dir/leads/public` | Public | Public/marketplace lead list where allowed. |
| POST | `/api/dir/contact` | Public | Public contact form submission. |
| GET | `/api/public/system-config` | Public | Public system settings required by frontend. |
| GET | `/api/public/page-status` | Public | Public page availability/maintenance status. |
| POST | `/api/visitor/events` | Public | Track website visits, searches, product views, vendor profile views and visitor lead context. |

## Vendor APIs

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/vendors/me` | Vendor | Current vendor profile. |
| PUT | `/api/vendors/me` | Vendor | Update vendor profile. |
| GET | `/api/vendors/me/preferences` | Vendor | Vendor lead/category preference settings. |
| PUT | `/api/vendors/me/preferences` | Vendor | Replace vendor preferences. |
| PATCH | `/api/vendors/me/preferences` | Vendor | Patch vendor preferences. |
| GET | `/api/vendors/me/coverage` | Vendor | Vendor service coverage regions. |
| PUT | `/api/vendors/me/coverage` | Vendor | Update vendor coverage regions. |
| GET | `/api/vendors/me/collections` | Vendor | Vendor collection/group assignments. |
| PUT | `/api/vendors/me/collections` | Vendor | Update vendor collection/group assignments. |
| GET | `/api/vendors/me/banks` | Vendor | List vendor bank accounts. |
| GET | `/api/vendors/me/banks/:bankId` | Vendor | Vendor bank account detail. |
| POST | `/api/vendors/me/banks` | Vendor | Create vendor bank account. |
| PUT | `/api/vendors/me/banks/:bankId` | Vendor | Update vendor bank account. |
| DELETE | `/api/vendors/me/banks/:bankId` | Vendor | Delete vendor bank account. |
| POST | `/api/vendors/me/upload` | Vendor | Upload vendor media/documents. |
| POST | `/api/vendors/me/kyc/submit` | Vendor | Submit KYC for review. |
| GET | `/api/vendors/me/documents` | Vendor | List current vendor documents. |
| GET | `/api/vendors/me/documents/:docId` | Vendor | Vendor document detail. |
| POST | `/api/vendors/me/documents` | Vendor | Add/upload vendor document. |
| DELETE | `/api/vendors/me/documents/:docId` | Vendor | Delete one vendor document. |
| DELETE | `/api/vendors/me/documents` | Vendor | Bulk delete vendor documents. |
| GET | `/api/vendors/me/marketplace-leads` | Vendor | Browse marketplace leads available to vendor. |
| POST | `/api/vendors/me/leads/:leadId/purchase` | Vendor | Purchase marketplace lead. |
| GET | `/api/vendors/me/leads/:leadId` | Vendor | Purchased lead detail. |
| GET | `/api/vendors/me/leads/:leadId/contacts` | Vendor | Lead contact follow-up records. |
| POST | `/api/vendors/me/leads/:leadId/contacts` | Vendor | Add lead contact/follow-up record. |
| GET | `/api/vendors/me/leads/:leadId/status-history` | Vendor | Lead status history. |
| POST | `/api/vendors/me/leads/:leadId/status` | Vendor | Update lead status. |
| GET | `/api/vendors/me/leads` | Vendor | Vendor leads/purchases. |
| POST | `/api/vendors/me/leads-create` | Vendor | Vendor creates requirement/lead as user/buyer style flow. |
| PATCH | `/api/vendors/me/leads/:leadId` | Vendor | Update vendor-created lead. |
| DELETE | `/api/vendors/me/leads/:leadId` | Vendor | Delete vendor-created lead. |
| GET | `/api/vendors/me/proposals` | Vendor | Buyer proposals visible to vendor. |
| GET | `/api/vendors/me/proposals/:proposalId` | Vendor | Proposal detail. |
| DELETE | `/api/vendors/me/proposals/:proposalId` | Vendor | Delete/hide vendor proposal record. |
| GET | `/api/vendors/me/lead-stats` | Vendor | Vendor lead statistics. |
| GET | `/api/vendors/me/dashboard-stats` | Vendor | Vendor dashboard summary. |
| GET | `/api/vendors/me/recent-products` | Vendor | Recent vendor products. |
| GET | `/api/vendors/me/recent-leads` | Vendor | Recent vendor leads. |
| GET | `/api/vendors/me/support-stats` | Vendor | Vendor support ticket stats. |
| GET | `/api/vendors/me/products` | Vendor | Vendor product list. |
| PATCH | `/api/vendors/me/products/:productId/metadata` | Vendor | Update product metadata. |
| PATCH | `/api/vendors/me/products/:productId/status` | Vendor | Update product status. |
| DELETE | `/api/vendors/me/products/:productId` | Vendor | Delete product. |
| DELETE | `/api/vendors/me/contact-persons/:contactId` | Vendor | Delete vendor contact person. |
| DELETE | `/api/vendors/me/purchases/:purchaseId` | Vendor | Delete purchase record. |
| DELETE | `/api/vendors/me/contacts/:contactId` | Vendor | Delete lead contact. |
| DELETE | `/api/vendors/me/messages/:messageId` | Vendor | Delete vendor message. |
| GET | `/api/vendors/:vendorId` | Public | Public vendor profile by UUID. |
| GET | `/api/vendors/:vendorSlug` | Public | Public vendor profile by slug. |
| GET | `/api/vendors/:vendorId/products` | Public | Public vendor products. |
| GET | `/api/vendors/:vendorId/services` | Public | Public vendor services. |
| GET | `/api/vendors/:vendorId/service-categories` | Public | Vendor service/category coverage. |
| GET | `/api/vendors/:vendorId/favorite` | Buyer | Check if vendor is favorited by buyer. |
| POST | `/api/vendors/:vendorId/favorite` | Buyer | Add vendor to buyer favorites. |
| DELETE | `/api/vendors/:vendorId/favorite` | Buyer | Remove vendor from buyer favorites. |
| POST | `/api/vendors/:vendorId/leads` | Optional auth | Public/buyer enquiry to vendor. |
| GET | `/api/vendors/:vendorId/leads` | Logged in | Vendor/admin lead list for vendor. |

## Buyer APIs

Primary prefix: `/api/buyer`.
Aliases also exist at `/api/buyers`, `/buyer`, `/buyers`, `/api/support`, `/support`, `/api`, and `/` for legacy clients.

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/buyer/proposals` | Buyer | List buyer proposals/RFQs. |
| POST | `/api/buyer/proposals` | Buyer | Create buyer proposal/RFQ. |
| GET | `/api/buyer/requirements` | Buyer | List buyer requirements/leads. |
| POST | `/api/buyer/requirements` | Buyer | Create buyer requirement. |
| GET | `/api/buyer/leads` | Buyer | List buyer leads. |
| POST | `/api/buyer/leads` | Buyer | Create buyer lead. |
| GET | `/api/buyer/rfq` | Buyer | RFQ list alias. |
| POST | `/api/buyer/rfq` | Buyer | RFQ create alias. |
| GET | `/api/buyer/rfqs` | Buyer | RFQs list alias. |
| POST | `/api/buyer/rfqs` | Buyer | RFQs create alias. |
| GET | `/api/buyer/suggestions` | Buyer | List buyer suggestions/feedback. |
| POST | `/api/buyer/suggestions` | Buyer | Create buyer suggestion. |
| POST | `/api/buyer/feedback` | Buyer | Create buyer feedback. |

## Quotation and Lead Communication APIs

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/quotation/sent` | Logged in | Quotations sent by current user/vendor. |
| GET | `/api/quotation/received` | Logged in | Quotations received by current user/vendor. |
| GET | `/api/quotation/received/:quotationId` | Logged in | Received quotation detail. |
| POST | `/api/quotation/messages/ack-delivered` | Logged in | Mark quote messages delivered. |
| GET | `/api/quotation/unread-count` | Logged in | Count unread quote messages. |
| GET | `/api/quotation/:proposalId/block-status` | Logged in | Check if proposal conversation is blocked. |
| POST | `/api/quotation/:proposalId/block` | Logged in | Block/unblock quote conversation. |
| GET | `/api/quotation/:proposalId/messages` | Logged in | List quote/proposal messages. |
| POST | `/api/quotation/:proposalId/messages` | Logged in | Send quote/proposal message. |
| PATCH | `/api/quotation/:proposalId/messages/:messageId` | Logged in | Edit message. |
| DELETE | `/api/quotation/:proposalId/messages` | Logged in | Delete all messages in conversation scope. |
| DELETE | `/api/quotation/:proposalId/messages/:messageId` | Logged in | Delete one message. |
| POST | `/api/quotation/send` | Logged in | Send formal quotation. |
| GET | `/api/quotation/admin/quotes` | Admin/internal | Admin quote list. |
| POST | `/api/category-requests` | Vendor | Vendor requests new category/micro-category. |
| PATCH | `/api/category-requests/:taskId/status` | Data entry/admin | Review and update category request status. |

## Payment and Finance APIs

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/payment/initiate` | Vendor/buyer context | Initiate subscription/payment order. |
| POST | `/api/payment/verify` | Vendor/buyer context | Verify payment callback/signature. |
| POST | `/api/payment/lead/initiate` | Vendor | Initiate marketplace lead purchase payment. |
| POST | `/api/payment/lead/verify` | Vendor | Verify lead purchase payment. |
| GET | `/api/payment/history/:vendor_id` | Logged in/internal | Vendor payment history. |
| GET | `/api/payment/invoice/:payment_id` | Logged in/internal | Invoice by payment id. |
| GET | `/api/payment/invoice/by-tx/:transaction_id` | Logged in/internal | Invoice by transaction id. |
| GET | `/api/payment/plans` | Public/internal | Public subscription plans. |
| GET | `/api/payment/market-context` | Public | Market/currency context for pricing display. |
| GET | `/api/payment/referral-offers/:vendor_id` | Vendor/internal | Referral offers for vendor. |
| GET | `/api/finance/payments` | Finance/admin | Finance payment list. |
| GET | `/api/finance/summary` | Finance/admin | Finance dashboard summary. |
| GET | `/api/finance/coupons/pending` | Finance/admin | Pending coupon approvals. |
| GET | `/api/finance/coupons` | Finance/admin | Coupon list. |
| POST | `/api/finance/coupons` | Finance/admin | Create coupon. |
| PUT | `/api/finance/coupons/:id` | Finance/admin | Update coupon. |
| POST | `/api/finance/coupons/:code/deactivate` | Finance/admin | Deactivate coupon by code. |
| DELETE | `/api/finance/coupons/:id` | Finance/admin | Delete coupon. |
| GET | `/api/finance/referrals/settings` | Finance/admin | Referral program settings. |
| PUT | `/api/finance/referrals/settings` | Finance/admin | Update referral settings. |
| PUT | `/api/finance/referrals/plan-rules/:planId` | Finance/admin | Update plan-level referral rules. |
| GET | `/api/finance/referrals/cashouts` | Finance/admin | Referral cashout queue. |
| POST | `/api/finance/referrals/cashouts/:id/approve` | Finance/admin | Approve referral cashout. |
| POST | `/api/finance/referrals/cashouts/:id/reject` | Finance/admin | Reject referral cashout. |
| POST | `/api/finance/referrals/cashouts/:id/mark-paid` | Finance/admin | Mark cashout as paid. |

## Employee, Sales and Subscription APIs

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/employee/me` | Employee | Current employee profile. |
| PUT | `/api/employee/me` | Employee | Update current employee profile. |
| GET | `/api/employee/staff` | Employee/admin | Staff list. |
| POST | `/api/employee/staff` | Employee/admin | Create staff member. |
| PATCH | `/api/employee/staff/:employeeId` | Employee/admin | Update staff member. |
| POST | `/api/employee/category-image-upload` | Employee | Upload category image. |
| POST | `/api/employee/product-media-upload` | Employee | Upload product media. |
| POST | `/api/employee/category-update` | Employee | Update category data from employee UI. |
| GET | `/api/employee/search360/vendors` | Support/sales/data/admin | Search 360 vendor/user lookup. |
| POST | `/api/employee/search360/escalations` | Support/sales/data/admin | Escalate Search 360 case to another team. |
| PATCH | `/api/employee/search360/cases/:caseId/status` | Support/sales/data/admin | Update Search 360 case status. |
| GET | `/api/employee/sales/stats` | Sales | Sales KPI stats. |
| GET | `/api/employee/sales/leads` | Sales | Sales lead queue, includes buyer/vendor visitor context. |
| POST | `/api/employee/sales/leads` | Sales | Create/manual import sales lead. |
| PATCH | `/api/employee/sales/leads/:leadId` | Sales | Update sales lead. |
| PATCH | `/api/employee/sales/leads/:leadId/status` | Sales | Update sales lead status. |
| GET | `/api/employee/sales/profile` | Sales | Sales employee profile and code. |
| GET | `/api/employee/sales/plans` | Sales | Plans available to share/sell. |
| GET | `/api/employee/sales/no-plan-vendors` | Sales | Vendors without active plans. |
| GET | `/api/employee/sales/reminders` | Sales | Follow-up reminders. |
| POST | `/api/employee/sales/reminders` | Sales | Create reminder. |
| PATCH | `/api/employee/sales/reminders/:id/status` | Sales | Update reminder status. |
| POST | `/api/employee/sales/plan-shares` | Sales | Share plan link/code with vendor. |
| GET | `/api/employee/sales/attributions` | Sales/manager | Plan sale attribution by sales code/link. |
| GET | `/api/employee/sales/dashboard` | Sales | Sales dashboard aggregates. |
| GET | `/api/employee/sales/pricing-rules` | Sales | Pricing rules visible to sales. |
| POST | `/api/employee/sales/pricing-rules` | Sales | Submit pricing rule for approval. |
| GET | `/api/employee/manager/pricing-approvals` | Manager | Pricing approval queue. |
| POST | `/api/employee/manager/pricing-approvals/:ruleId/decision` | Manager | Approve/reject pricing rule. |
| GET | `/api/employee/sales/vendors` | Sales | Vendor list for sales workflows. |
| POST | `/api/employee/subscription-requests` | Sales | Create subscription extension request. |
| GET | `/api/employee/subscription-requests` | Sales | My subscription extension requests. |
| GET | `/api/employee/subscription-requests/manager` | Manager | Manager approval queue. |
| POST | `/api/employee/subscription-requests/:id/manager-forward` | Manager | Forward request to VP/admin. |
| GET | `/api/employee/subscription-requests/vp` | VP | VP approval queue. |
| POST | `/api/employee/subscription-requests/:id/vp-forward` | VP | Forward request to admin. |
| GET | `/api/employee/dashboard/stats` | Employee | Employee dashboard stats. |
| GET | `/api/employee/requirements` | Employee | Requirement/lead submissions for internal follow-up. |
| PATCH | `/api/employee/requirements/:id/status` | Employee | Update requirement status. |
| GET | `/api/employee/suggestions` | Employee | Buyer/user suggestions list. |

## Data Entry APIs

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/data-entry/dashboard/stats` | Data entry | Data-entry dashboard stats. |
| GET | `/api/data-entry/dashboard/recent-activities` | Data entry | Recent data-entry activity. |
| GET | `/api/data-entry/dashboard/category-requests` | Data entry | Category request queue. |
| GET | `/api/data-entry/vendors` | Data entry | Vendor list. |
| POST | `/api/data-entry/vendors` | Data entry | Create vendor. |
| GET | `/api/data-entry/vendors/:vendorId` | Data entry | Vendor detail. |
| GET | `/api/data-entry/vendors/:vendorId/documents` | Data entry | Vendor documents. |
| POST | `/api/data-entry/vendors/:vendorId/documents` | Data entry | Add vendor document. |
| GET | `/api/data-entry/vendors/:vendorId/kyc-grouped` | Data entry | Grouped KYC document/status view. |
| GET | `/api/data-entry/vendors/:vendorId/products` | Data entry | Vendor products. |
| GET | `/api/data-entry/vendors/:vendorId/bank-details` | Data entry | Vendor bank detail. |
| POST | `/api/data-entry/vendors/:vendorId/bank-details` | Data entry | Save vendor bank detail. |
| GET | `/api/data-entry/vendors/:vendorId/contacts` | Data entry | Vendor contacts. |
| POST | `/api/data-entry/vendors/:vendorId/contacts` | Data entry | Add vendor contact. |
| GET | `/api/data-entry/vendors/:vendorId/subscriptions` | Data entry | Vendor subscription history. |
| GET | `/api/data-entry/products/:productId` | Data entry | Product detail. |
| POST | `/api/data-entry/products` | Data entry | Create product. |
| PUT | `/api/data-entry/products/:productId` | Data entry | Update product. |
| POST | `/api/data-entry/products/:productId/images` | Data entry | Add product images. |
| GET | `/api/data-entry/categories/tree` | Data entry | Full category tree. |
| GET | `/api/data-entry/categories/head` | Data entry | Head category list. |
| POST | `/api/data-entry/categories/head` | Data entry | Create head category. |
| PUT | `/api/data-entry/categories/head/:id` | Data entry | Update head category. |
| DELETE | `/api/data-entry/categories/head/:id` | Data entry | Delete head category. |
| GET | `/api/data-entry/categories/sub` | Data entry | Sub-category list. |
| POST | `/api/data-entry/categories/sub` | Data entry | Create sub-category. |
| PUT | `/api/data-entry/categories/sub/:id` | Data entry | Update sub-category. |
| DELETE | `/api/data-entry/categories/sub/:id` | Data entry | Delete sub-category. |
| GET | `/api/data-entry/categories/micro` | Data entry | Micro-category list. |
| POST | `/api/data-entry/categories/micro` | Data entry | Create micro-category. |
| PUT | `/api/data-entry/categories/micro/:id` | Data entry | Update micro-category. |
| DELETE | `/api/data-entry/categories/micro/:id` | Data entry | Delete micro-category. |
| POST | `/api/data-entry/categories/import-csv` | Data entry | Bulk category CSV import. |
| GET | `/api/data-entry/locations/states` | Data entry | State list. |
| POST | `/api/data-entry/locations/states` | Data entry | Create state. |
| PUT | `/api/data-entry/locations/states/:id` | Data entry | Update state. |
| DELETE | `/api/data-entry/locations/states/:id` | Data entry | Delete state. |
| GET | `/api/data-entry/locations/cities` | Data entry | City list. |
| POST | `/api/data-entry/locations/cities` | Data entry | Create city. |
| PUT | `/api/data-entry/locations/cities/:id` | Data entry | Update city. |
| DELETE | `/api/data-entry/locations/cities/:id` | Data entry | Delete city. |
| POST | `/api/data-entry/locations/import-csv` | Data entry | Bulk location CSV import. |
| GET | `/api/data-entry/vendor-plans` | Data entry | Vendor plan list/reference. |

## Territory APIs

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/territory/divisions` | Internal | Geo/territory divisions. |
| GET | `/api/territory/employees` | Internal | Employees eligible for territory allocation. |
| GET | `/api/territory/allocations/vp-manager` | VP/admin | VP to manager allocations. |
| POST | `/api/territory/allocations/vp-manager` | VP/admin | Assign managers to VP/state scope. |
| GET | `/api/territory/allocations/manager-sales` | Manager/VP/admin | Manager to sales allocations. |
| POST | `/api/territory/allocations/manager-sales` | Manager/VP/admin | Assign sales employees to manager scope. |
| GET | `/api/territory/sales/vendors` | Sales/manager | Vendors in territory for engagement. |
| POST | `/api/territory/sales/engagements` | Sales | Create sales engagement/touchpoint. |
| GET | `/api/territory/sales/engagements` | Sales/manager/VP | List sales engagements, plan shares, reminders and conversions. |

## Support APIs

Primary support ticket prefix: `/api/support`.

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/support/tickets` | Support/internal | List support tickets. |
| POST | `/api/support/tickets` | Support/internal/public context | Create support ticket. |
| GET | `/api/support/tickets/:id` | Support/internal | Ticket detail. |
| PATCH | `/api/support/tickets/:id` | Support/internal | Update ticket. |
| DELETE | `/api/support/tickets/:id` | Support/internal | Delete ticket. |
| PUT | `/api/support/tickets/:id/status` | Support/internal | Update ticket status. |
| GET | `/api/support/tickets/:id/messages` | Support/internal | Ticket messages. |
| POST | `/api/support/tickets/:id/messages` | Support/internal | Add ticket message. |
| POST | `/api/support/tickets/:id/notify-customer` | Support/internal | Notify customer about ticket. |
| POST | `/api/support/tickets/:id/escalate` | Admin/support/sales | Escalate ticket to admin, data entry or sales. |
| GET | `/api/support/stats` | Support/internal | Support dashboard stats. |
| GET | `/api/support/vendor/:vendorId` | Support/internal | Vendor support history. |
| GET | `/api/support/buyer/:buyerId` | Support/internal | Buyer support history. |

## KYC APIs

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/kyc/vendors` | Internal | Vendors waiting for KYC review. |
| POST | `/api/kyc/vendors/document-counts` | Internal | Batch document counts by vendor. |
| GET | `/api/kyc/vendors/:vendorId/documents` | Internal | Vendor KYC documents. |
| POST | `/api/kyc/vendors/:vendorId/approve` | Internal | Approve vendor KYC. |
| POST | `/api/kyc/vendors/:vendorId/reject` | Internal | Reject vendor KYC with reason. |
| POST | `/api/kyc/vendors/:vendorId/reminder` | Internal | Send KYC reminder. |
| GET | `/api/kyc/vendors/:vendorId/remarks` | Internal | KYC remarks/history. |

## Referral APIs

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/referrals/me` | Vendor | Current vendor referral wallet/code. |
| POST | `/api/referrals/link` | Vendor | Create/refetch referral link. |
| GET | `/api/referrals/cashouts` | Vendor | Vendor cashout requests. |
| POST | `/api/referrals/cashout` | Vendor | Request referral cashout. |

## Admin APIs

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/admin/search360/vendors` | Admin | Search 360 vendor/user lookup. |
| POST | `/api/admin/search360/escalations` | Admin | Create Search 360 escalation. |
| PATCH | `/api/admin/search360/cases/:caseId/status` | Admin | Update Search 360 case status. |
| GET | `/api/admin/system-config` | Admin | System config. |
| PUT | `/api/admin/system-config` | Admin | Update system config. |
| GET | `/api/admin/coupons/pending` | Admin | Pending coupon approvals. |
| POST | `/api/admin/coupons/:id/decision` | Admin | Approve/reject coupon request. |
| GET | `/api/admin/audit-logs` | Admin | Audit log list. |
| GET | `/api/admin/vendors` | Admin | Vendor list with filters. |
| GET | `/api/admin/vendors/:vendorId` | Admin | Vendor detail. |
| GET | `/api/admin/vendors/:vendorId/products` | Admin | Vendor product list. |
| POST | `/api/admin/vendors/:vendorId/terminate` | Admin | Terminate/suspend vendor. |
| POST | `/api/admin/vendors/:vendorId/activate` | Admin | Reactivate vendor. |
| POST | `/api/admin/vendors/:vendorId/assign` | Admin | Assign vendor to employee/team. |
| GET | `/api/admin/buyers` | Admin | Buyer list. |
| PUT | `/api/admin/buyers/:buyerId` | Admin | Update buyer. |
| POST | `/api/admin/buyers/:buyerId/terminate` | Admin | Terminate buyer. |
| POST | `/api/admin/buyers/:buyerId/activate` | Admin | Reactivate buyer. |
| GET | `/api/admin/users` | Admin | User list. |
| GET | `/api/admin/users/:id` | Admin | User detail. |
| GET | `/api/admin/products` | Admin | Product list. |
| PUT | `/api/admin/products/:productId` | Admin | Update product. |
| DELETE | `/api/admin/products/:productId` | Admin | Delete product. |
| GET | `/api/admin/staff` | Admin | Staff list. |
| POST | `/api/admin/staff` | Admin | Create staff. |
| PATCH | `/api/admin/staff/:employeeId` | Admin | Update staff. |
| DELETE | `/api/admin/staff/:employeeId` | Admin | Delete staff. |
| PUT | `/api/admin/staff/:employeeId/password` | Admin | Reset staff password. |
| GET | `/api/admin/dashboard/overview` | Admin | Admin dashboard overview. |
| GET | `/api/admin/dashboard/counts` | Admin | Dashboard counts. |
| GET | `/api/admin/dashboard/visitor-activity` | Admin | Visitor activity feed. |
| GET | `/api/admin/dashboard/recent-support-tickets` | Admin | Recent support tickets. |
| GET | `/api/admin/dashboard/recent-vendors` | Admin | Recent vendors. |
| GET | `/api/admin/dashboard/recent-lead-purchases` | Admin | Recent lead purchases. |
| GET | `/api/admin/dashboard/data-entry-performance` | Admin | Data-entry performance stats. |
| GET | `/api/admin/subscription-requests/pending` | Admin | Pending subscription extension requests. |
| POST | `/api/admin/subscription-requests/:id/resolve` | Admin | Resolve subscription extension request. |
| GET | `/api/admin/states` | Admin | State list. |
| POST | `/api/admin/states` | Admin | Create state. |
| PUT | `/api/admin/states/:id` | Admin | Update state. |
| DELETE | `/api/admin/states/:id` | Admin | Delete state. |
| GET | `/api/admin/cities` | Admin | City list. |
| POST | `/api/admin/cities` | Admin | Create city. |
| PUT | `/api/admin/cities/:id` | Admin | Update city. |
| DELETE | `/api/admin/cities/:id` | Admin | Delete city. |
| GET | `/api/admin/categories/micro/:microId/meta` | Admin | Micro-category SEO/meta detail. |
| POST | `/api/admin/categories/micro/meta` | Admin | Create micro-category SEO/meta. |
| POST | `/api/admin/categories/micro/meta/:id` | Admin | Update micro-category SEO/meta. |
| DELETE | `/api/admin/categories/micro/meta/:id` | Admin | Delete micro-category SEO/meta. |

## Superadmin APIs

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/superadmin/login` | Public | Superadmin login. |
| GET | `/api/superadmin/me` | Superadmin | Current superadmin profile. |
| PUT | `/api/superadmin/password` | Superadmin | Change superadmin password. |
| GET | `/api/superadmin/impersonation/targets` | Superadmin | List vendor/buyer targets for impersonation. |
| POST | `/api/superadmin/impersonation/start` | Superadmin | Start vendor/buyer impersonation. |
| POST | `/api/superadmin/impersonation/stop` | Superadmin | Stop impersonation. |
| GET | `/api/superadmin/search360/vendors` | Superadmin | Search 360 global vendor/user lookup. |
| POST | `/api/superadmin/search360/escalations` | Superadmin | Create Search 360 escalation. |
| PATCH | `/api/superadmin/search360/cases/:caseId/status` | Superadmin | Update Search 360 case status. |
| GET | `/api/superadmin/states` | Superadmin | State list. |
| GET | `/api/superadmin/employees` | Superadmin | Employee list. |
| POST | `/api/superadmin/employees` | Superadmin | Create employee. |
| DELETE | `/api/superadmin/employees/:employeeId` | Superadmin | Delete employee. |
| PUT | `/api/superadmin/employees/:employeeId/password` | Superadmin | Reset employee password. |
| PUT | `/api/superadmin/employees/:id/states-scope` | Superadmin | Update employee state/region scope. |
| GET | `/api/superadmin/vendors` | Superadmin | Vendor list. |
| DELETE | `/api/superadmin/vendors/:vendorId` | Superadmin | Delete vendor. |
| GET | `/api/superadmin/plans` | Superadmin | Subscription plan list, including currency/region pricing fields. |
| POST | `/api/superadmin/plans` | Superadmin | Create subscription plan. |
| PUT | `/api/superadmin/plans/:planId` | Superadmin | Update subscription plan. |
| DELETE | `/api/superadmin/plans/:planId` | Superadmin | Delete subscription plan. |
| GET | `/api/superadmin/finance/summary` | Superadmin | Finance summary. |
| GET | `/api/superadmin/finance/payments` | Superadmin | Payment list. |
| GET | `/api/superadmin/system-config` | Superadmin | System config. |
| PUT | `/api/superadmin/system-config` | Superadmin | Update system config. |
| GET | `/api/superadmin/page-status` | Superadmin | Page status list. |
| POST | `/api/superadmin/page-status` | Superadmin | Create page status rule. |
| PUT | `/api/superadmin/page-status/:pageId` | Superadmin | Update page status rule. |
| DELETE | `/api/superadmin/page-status/:pageId` | Superadmin | Delete page status rule. |
| GET | `/api/superadmin/audit-logs` | Superadmin | Audit logs. |
| GET | `/api/superadmin/monitoring/overview` | Superadmin | Platform monitoring overview. |
| GET | `/api/superadmin/monitoring/admin-activity` | Superadmin | Admin activity monitoring. |
| GET | `/api/superadmin/monitoring/revenue-by-state` | Superadmin | Revenue by state report. |
| GET | `/api/superadmin/visitor-activity` | Superadmin/developer | Website visitor event feed. |
| GET | `/api/superadmin/godmode/superadmins` | Developer/god mode | List superadmins. |
| POST | `/api/superadmin/godmode/superadmins` | Developer/god mode | Create superadmin. |
| PUT | `/api/superadmin/godmode/superadmins/:id/toggle-active` | Developer/god mode | Activate/deactivate superadmin. |
| DELETE | `/api/superadmin/godmode/superadmins/:id` | Developer/god mode | Delete superadmin. |
| PUT | `/api/superadmin/godmode/superadmins/:id/password` | Developer/god mode | Reset superadmin password. |

## Notifications and Chat APIs

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/notifications` | Logged in | Notification list. |
| GET | `/api/notifications/list` | Logged in | Notification list alias. |
| GET | `/api/notifications/unread-count` | Logged in | Unread notification count. |
| POST | `/api/notifications/read-all` | Logged in | Mark all notifications read. |
| PATCH | `/api/notifications/:id/read` | Logged in | Mark one notification read. |
| PATCH | `/api/notifications/read` | Logged in | Mark notification(s) read by payload. |
| DELETE | `/api/notifications/:id` | Logged in | Delete one notification. |
| DELETE | `/api/notifications` | Logged in | Bulk delete notifications. |
| POST | `/api/chat` | Public/session context | Chatbot reply endpoint. |

## Utility and Migration APIs

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/health` | Public | Backend health check. |
| POST | `/api/db/query` | Optional/internal | Controlled database query proxy used by internal tooling. |
| POST | `/api/migration/vendor-ids/migrate-single` | Internal | Generate/migrate one vendor id. |
| POST | `/api/migration/vendor-ids/migrate-all` | Internal | Generate/migrate vendor ids in bulk. |

## Integration Notes

- Public directory APIs are safe to call from public pages and are cached where configured.
- Mutating APIs should be called with `Content-Type: application/json`.
- Browser clients must send cookies with `credentials: "include"`.
- File/media upload APIs may use `multipart/form-data`; do not force JSON headers for those requests.
- Product image, category image and visitor tracking APIs normalize public URLs for frontend rendering.
- For role-switch flows, call `/api/auth/switch/buyer` or `/api/auth/switch/vendor`, then refresh `/api/auth/me`.
- For Search 360, prefer the role-specific prefix already available to the current portal:
  - Support/sales/data-entry/manager/VP: `/api/employee/search360/*`
  - Admin: `/api/admin/search360/*`
  - Superadmin/developer: `/api/superadmin/search360/*`
- For SEO, sitemap files are static frontend assets; they are not served by backend API routes.
