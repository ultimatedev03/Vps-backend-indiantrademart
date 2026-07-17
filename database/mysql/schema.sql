-- Indian Trade Mart MySQL schema
-- Generated from the current application database metadata. Runtime uses MySQL only.
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS `admin_users` (
  `id` CHAR(36) NOT NULL,
  `email` VARCHAR(191) NULL,
  `password_hash` TEXT NULL,
  `full_name` TEXT NULL,
  `role` VARCHAR(191) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `phone` VARCHAR(191) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_admin_users_email` (`email`),
  KEY `idx_admin_users_email` (`email`),
  KEY `idx_admin_users_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `audit_logs` (
  `id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NULL,
  `action` TEXT NULL,
  `entity_type` TEXT NULL,
  `entity_id` VARCHAR(191) NULL,
  `details` JSON NULL,
  `ip_address` TEXT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_audit_logs_user_id` (`user_id`),
  KEY `idx_audit_logs_entity_id` (`entity_id`),
  KEY `idx_audit_logs_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `auth_otps` (
  `id` CHAR(36) NOT NULL,
  `email` VARCHAR(191) NULL,
  `otp_code` VARCHAR(191) NULL,
  `expires_at` DATETIME NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `used` TINYINT(1) DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_auth_otps_email` (`email`),
  KEY `idx_auth_otps_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `buyer_notifications` (
  `id` CHAR(36) NOT NULL,
  `buyer_id` CHAR(36) NULL,
  `type` VARCHAR(191) NULL,
  `title` TEXT NULL,
  `message` TEXT NULL,
  `reference_id` CHAR(36) NULL,
  `reference_type` TEXT NULL,
  `is_read` TINYINT(1) DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_buyer_notifications_buyer_id` (`buyer_id`),
  KEY `idx_buyer_notifications_reference_id` (`reference_id`),
  KEY `idx_buyer_notifications_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `buyer_support_tickets` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `subject` TEXT NULL,
  `status` VARCHAR(191) NULL,
  `last_reply_at` DATETIME NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `buyer_id` CHAR(36) NULL,
  `description` TEXT NULL,
  `category` TEXT NULL,
  `priority` TEXT NULL,
  `ticket_display_id` VARCHAR(191) NULL,
  `attachments` JSON NULL,
  `resolved_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  KEY `idx_buyer_support_tickets_vendor_id` (`vendor_id`),
  KEY `idx_buyer_support_tickets_status` (`status`),
  KEY `idx_buyer_support_tickets_created_at` (`created_at`),
  KEY `idx_buyer_support_tickets_buyer_id` (`buyer_id`),
  KEY `idx_buyer_support_tickets_ticket_display_id` (`ticket_display_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `buyers` (
  `id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NULL,
  `full_name` TEXT NULL,
  `email` VARCHAR(191) NULL,
  `phone` VARCHAR(191) NULL,
  `company_name` TEXT NULL,
  `company_type` TEXT NULL,
  `industry` TEXT NULL,
  `state` TEXT NULL,
  `city` TEXT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `state_id` CHAR(36) NULL,
  `city_id` CHAR(36) NULL,
  `pan_card` TEXT NULL,
  `address` TEXT NULL,
  `pincode` TEXT NULL,
  `gst_number` TEXT NULL,
  `avatar_url` TEXT NULL,
  `is_active` TINYINT(1) DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_buyers_user_id` (`user_id`),
  KEY `idx_buyers_user_id` (`user_id`),
  KEY `idx_buyers_email` (`email`),
  KEY `idx_buyers_created_at` (`created_at`),
  KEY `idx_buyers_state_id` (`state_id`),
  KEY `idx_buyers_city_id` (`city_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `categories` (
  `id` CHAR(36) NOT NULL,
  `name` TEXT NULL,
  `slug` VARCHAR(191) NULL,
  `level` INT NULL,
  `parent_id` CHAR(36) NULL,
  `description` TEXT NULL,
  `image_url` TEXT NULL,
  `is_active` TINYINT(1) DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_categories_slug` (`slug`),
  KEY `idx_categories_parent_id` (`parent_id`),
  KEY `idx_categories_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `chat_blocks` (
  `id` CHAR(36) NOT NULL,
  `blocker_user_id` CHAR(36) NULL,
  `blocked_user_id` CHAR(36) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_chat_blocks_pair` (`blocker_user_id`, `blocked_user_id`),
  KEY `idx_chat_blocks_blocker_user_id` (`blocker_user_id`),
  KEY `idx_chat_blocks_blocked_user_id` (`blocked_user_id`),
  KEY `idx_chat_blocks_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `chatbot_history` (
  `id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NULL,
  `message` TEXT NULL,
  `sender` TEXT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_chatbot_history_user_id` (`user_id`),
  KEY `idx_chatbot_history_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cities` (
  `id` CHAR(36) NOT NULL,
  `state_id` CHAR(36) NULL,
  `district_id` CHAR(36) NULL,
  `name` TEXT NULL,
  `slug` VARCHAR(191) NULL,
  `is_active` TINYINT(1) DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `supplier_count` INT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_cities_state_id` (`state_id`),
  KEY `idx_cities_district_id` (`district_id`),
  KEY `idx_cities_state_district_slug` (`state_id`, `district_id`, `slug`),
  KEY `idx_cities_slug` (`slug`),
  KEY `idx_cities_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `districts` (
  `id` CHAR(36) NOT NULL,
  `state_id` CHAR(36) NULL,
  `name` TEXT NULL,
  `slug` VARCHAR(191) NULL,
  `is_active` TINYINT(1) DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `supplier_count` INT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_districts_state_id` (`state_id`),
  KEY `idx_districts_state_slug` (`state_id`, `slug`),
  KEY `idx_districts_slug` (`slug`),
  KEY `idx_districts_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `contact_submissions` (
  `id` CHAR(36) NOT NULL,
  `name` TEXT NULL,
  `email` VARCHAR(191) NULL,
  `phone` VARCHAR(191) NULL,
  `message` TEXT NULL,
  `status` VARCHAR(191) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_contact_submissions_email` (`email`),
  KEY `idx_contact_submissions_status` (`status`),
  KEY `idx_contact_submissions_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `employee_state_scope` (
  `employee_id` CHAR(36) NOT NULL,
  `state_id` CHAR(36) NOT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`employee_id`, `state_id`),
  KEY `idx_employee_state_scope_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `employees` (
  `id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NULL,
  `full_name` TEXT NULL,
  `email` VARCHAR(191) NULL,
  `phone` VARCHAR(191) NULL,
  `role` VARCHAR(191) NULL,
  `department` TEXT NULL,
  `status` VARCHAR(191) NULL,
  `sales_code` VARCHAR(191) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `states_scope` JSON NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_employees_user_id` (`user_id`),
  UNIQUE KEY `uq_employees_sales_code` (`sales_code`),
  KEY `idx_employees_user_id` (`user_id`),
  KEY `idx_employees_email` (`email`),
  KEY `idx_employees_status` (`status`),
  KEY `idx_employees_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `favorites` (
  `id` CHAR(36) NOT NULL,
  `buyer_id` CHAR(36) NULL,
  `vendor_id` CHAR(36) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_favorites_buyer_id` (`buyer_id`),
  KEY `idx_favorites_vendor_id` (`vendor_id`),
  KEY `idx_favorites_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `product_ratings` (
  `id` CHAR(36) NOT NULL,
  `product_id` CHAR(36) NOT NULL,
  `buyer_id` CHAR(36) NOT NULL,
  `buyer_name` TEXT NULL,
  `rating` TINYINT NULL,
  `feedback` TEXT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_product_ratings_product_buyer` (`product_id`, `buyer_id`),
  KEY `idx_product_ratings_product_id` (`product_id`),
  KEY `idx_product_ratings_buyer_id` (`buyer_id`),
  KEY `idx_product_ratings_updated_at` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `geo_division_pincodes` (
  `id` CHAR(36) NOT NULL,
  `division_id` CHAR(36) NULL,
  `pincode` VARCHAR(32) NULL,
  `source_district_name` TEXT NULL,
  `source_subdistrict_name` TEXT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_geo_division_pincodes_division_pincode` (`division_id`, `pincode`),
  KEY `idx_geo_division_pincodes_division_id` (`division_id`),
  KEY `idx_geo_division_pincodes_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `geo_divisions` (
  `id` CHAR(36) NOT NULL,
  `division_key` VARCHAR(191) NULL,
  `state_id` CHAR(36) NULL,
  `city_id` CHAR(36) NULL,
  `name` TEXT NULL,
  `slug` VARCHAR(191) NULL,
  `district_name` TEXT NULL,
  `subdistrict_name` TEXT NULL,
  `pincode_count` INT NULL,
  `is_active` TINYINT(1) DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_geo_divisions_division_key` (`division_key`),
  KEY `idx_geo_divisions_state_id` (`state_id`),
  KEY `idx_geo_divisions_city_id` (`city_id`),
  KEY `idx_geo_divisions_slug` (`slug`),
  KEY `idx_geo_divisions_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `geo_postal_raw` (
  `id` CHAR(36) NOT NULL,
  `state_code` VARCHAR(191) NULL,
  `state_name` TEXT NULL,
  `district_code` VARCHAR(191) NULL,
  `district_name` TEXT NULL,
  `subdistrict_code` VARCHAR(191) NULL,
  `subdistrict_name` TEXT NULL,
  `village_code` VARCHAR(191) NULL,
  `village_name` TEXT NULL,
  `pincode` TEXT NULL,
  `source_file` TEXT NULL,
  `imported_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `head_categories` (
  `id` CHAR(36) NOT NULL,
  `name` TEXT NULL,
  `slug` VARCHAR(191) NULL,
  `is_active` TINYINT(1) DEFAULT 0,
  `created_by` CHAR(36) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `image_url` TEXT NULL,
  `description` TEXT NULL,
  `meta_tags` TEXT NULL,
  `keywords` TEXT NULL,
  `sort_order` INT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_head_categories_slug` (`slug`),
  KEY `idx_head_categories_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `kyc_documents` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `document_type` TEXT NULL,
  `document_url` TEXT NULL,
  `file_path` TEXT NULL,
  `status` VARCHAR(191) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_kyc_documents_vendor_id` (`vendor_id`),
  KEY `idx_kyc_documents_status` (`status`),
  KEY `idx_kyc_documents_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `kyc_remarks` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `remarks` TEXT NULL,
  `created_by` CHAR(36) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_kyc_remarks_vendor_id` (`vendor_id`),
  KEY `idx_kyc_remarks_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lead_contacts` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `lead_id` CHAR(36) NULL,
  `contact_type` TEXT NULL,
  `contact_date` DATETIME NULL,
  `notes` TEXT NULL,
  `status` VARCHAR(191) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_lead_contacts_vendor_id` (`vendor_id`),
  KEY `idx_lead_contacts_lead_id` (`lead_id`),
  KEY `idx_lead_contacts_status` (`status`),
  KEY `idx_lead_contacts_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lead_purchases` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `lead_id` CHAR(36) NULL,
  `purchase_date` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `amount` DECIMAL(16,2) NULL,
  `payment_status` TEXT NULL,
  `consumption_type` TEXT NULL,
  `purchase_price` DECIMAL(16,2) NULL,
  `purchase_datetime` DATETIME NULL,
  `subscription_plan_name` TEXT NULL,
  `lead_status` TEXT NULL,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_lead_purchases_vendor_id` (`vendor_id`),
  KEY `idx_lead_purchases_lead_id` (`lead_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lead_purchases_backup_20260222` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `lead_id` CHAR(36) NULL,
  `purchase_date` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `amount` DECIMAL(16,2) NULL,
  `payment_status` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_lead_purchases_backup_20260222_vendor_id` (`vendor_id`),
  KEY `idx_lead_purchases_backup_20260222_lead_id` (`lead_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lead_status_history` (
  `id` CHAR(36) NOT NULL,
  `lead_id` CHAR(36) NULL,
  `vendor_id` CHAR(36) NULL,
  `lead_purchase_id` CHAR(36) NULL,
  `status` VARCHAR(191) NULL,
  `note` TEXT NULL,
  `source` TEXT NULL,
  `created_by` CHAR(36) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_lead_status_history_lead_id` (`lead_id`),
  KEY `idx_lead_status_history_vendor_id` (`vendor_id`),
  KEY `idx_lead_status_history_lead_purchase_id` (`lead_purchase_id`),
  KEY `idx_lead_status_history_status` (`status`),
  KEY `idx_lead_status_history_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `leads` (
  `id` CHAR(36) NOT NULL,
  `buyer_name` TEXT NULL,
  `buyer_phone` TEXT NULL,
  `title` TEXT NULL,
  `product_name` TEXT NULL,
  `quantity` TEXT NULL,
  `budget` TEXT NULL,
  `category` TEXT NULL,
  `location` TEXT NULL,
  `status` VARCHAR(191) NULL,
  `price` DECIMAL(16,2) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `vendor_id` CHAR(36) NULL,
  `buyer_email` TEXT NULL,
  `company_name` TEXT NULL,
  `product_interest` TEXT NULL,
  `message` TEXT NULL,
  `category_slug` TEXT NULL,
  `description` TEXT NULL,
  `buyer_id` CHAR(36) NULL,
  `buyer_user_id` CHAR(36) NULL,
  `micro_category_id` CHAR(36) NULL,
  `sub_category_id` CHAR(36) NULL,
  `head_category_id` CHAR(36) NULL,
  `state_id` CHAR(36) NULL,
  `city_id` CHAR(36) NULL,
  `source` TEXT NULL,
  `vendor_email` TEXT NULL,
  `city` TEXT NULL,
  `state` TEXT NULL,
  `pincode` TEXT NULL,
  `assigned_to` CHAR(36) NULL,
  `assigned_sales_user_id` CHAR(36) NULL,
  `sales_note` TEXT NULL,
  `last_follow_up_at` DATETIME NULL,
  `next_follow_up_at` DATETIME NULL,
  `visitor_id` VARCHAR(191) NULL,
  `visitor_session_id` VARCHAR(191) NULL,
  `lead_origin` VARCHAR(191) NULL,
  `landing_page` TEXT NULL,
  `page_url` TEXT NULL,
  `referrer` TEXT NULL,
  `user_agent` TEXT NULL,
  `consent_source` VARCHAR(191) NULL,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `expires_at` DATETIME NULL,
  `proposal_id` CHAR(36) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_leads_status` (`status`),
  KEY `idx_leads_created_at` (`created_at`),
  KEY `idx_leads_vendor_id` (`vendor_id`),
  KEY `idx_leads_buyer_id` (`buyer_id`),
  KEY `idx_leads_buyer_user_id` (`buyer_user_id`),
  KEY `idx_leads_assigned_to` (`assigned_to`),
  KEY `idx_leads_assigned_sales_user_id` (`assigned_sales_user_id`),
  KEY `idx_leads_next_follow_up_at` (`next_follow_up_at`),
  KEY `idx_leads_micro_category_id` (`micro_category_id`),
  KEY `idx_leads_sub_category_id` (`sub_category_id`),
  KEY `idx_leads_head_category_id` (`head_category_id`),
  KEY `idx_leads_state_id` (`state_id`),
  KEY `idx_leads_city_id` (`city_id`),
  KEY `idx_leads_visitor_id` (`visitor_id`),
  KEY `idx_leads_lead_origin` (`lead_origin`),
  KEY `idx_leads_proposal_id` (`proposal_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `website_visitor_events` (
  `id` CHAR(36) NOT NULL,
  `visitor_id` VARCHAR(191) NULL,
  `visitor_session_id` VARCHAR(191) NULL,
  `visitor_name` TEXT NULL,
  `visitor_email` VARCHAR(191) NULL,
  `visitor_phone` VARCHAR(64) NULL,
  `visitor_company` TEXT NULL,
  `visitor_contact_source` VARCHAR(191) NULL,
  `event_type` VARCHAR(64) NULL,
  `page_url` TEXT NULL,
  `page_path` VARCHAR(512) NULL,
  `page_title` TEXT NULL,
  `referrer` TEXT NULL,
  `utm_source` VARCHAR(191) NULL,
  `utm_medium` VARCHAR(191) NULL,
  `utm_campaign` VARCHAR(191) NULL,
  `utm_term` VARCHAR(191) NULL,
  `utm_content` VARCHAR(191) NULL,
  `search_query` TEXT NULL,
  `entity_type` VARCHAR(64) NULL,
  `entity_id` VARCHAR(191) NULL,
  `entity_name` TEXT NULL,
  `category` TEXT NULL,
  `city` TEXT NULL,
  `state` TEXT NULL,
  `ip_address` VARCHAR(64) NULL,
  `user_agent` TEXT NULL,
  `metadata` JSON NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_website_visitor_events_visitor_id` (`visitor_id`),
  KEY `idx_website_visitor_events_session_id` (`visitor_session_id`),
  KEY `idx_website_visitor_events_event_type` (`event_type`),
  KEY `idx_website_visitor_events_created_at` (`created_at`),
  KEY `idx_website_visitor_events_entity` (`entity_type`, `entity_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `behavioral_event_queue` (
  `id` CHAR(36) NOT NULL,
  `event_id` CHAR(36) NULL,
  `visitor_id` VARCHAR(191) NULL,
  `event_type` VARCHAR(64) NULL,
  `payload` JSON NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  `attempts` INT NOT NULL DEFAULT 0,
  `error_message` TEXT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `processed_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_behavioral_event_queue_event_id` (`event_id`),
  KEY `idx_behavioral_event_queue_status_created` (`status`, `created_at`),
  KEY `idx_behavioral_event_queue_visitor_created` (`visitor_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `behavioral_hourly_aggregates` (
  `id` CHAR(36) NOT NULL,
  `bucket_start` DATETIME NOT NULL,
  `event_type` VARCHAR(64) NOT NULL,
  `demand_key` VARCHAR(191) NOT NULL,
  `display_label` TEXT NULL,
  `category` TEXT NULL,
  `state` VARCHAR(191) NOT NULL DEFAULT '',
  `city` VARCHAR(191) NOT NULL DEFAULT '',
  `entity_type` VARCHAR(64) NULL,
  `entity_id` VARCHAR(191) NULL,
  `event_count` INT NOT NULL DEFAULT 0,
  `unique_visitors` INT NOT NULL DEFAULT 0,
  `lead_count` INT NOT NULL DEFAULT 0,
  `computed_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_behavioral_hourly_bucket_key` (`bucket_start`, `event_type`, `demand_key`, `state`, `city`),
  KEY `idx_behavioral_hourly_demand` (`demand_key`, `bucket_start`),
  KEY `idx_behavioral_hourly_location` (`state`, `city`, `bucket_start`),
  KEY `idx_behavioral_hourly_event` (`event_type`, `bucket_start`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `behavioral_demand_scores` (
  `id` CHAR(36) NOT NULL,
  `demand_key` VARCHAR(191) NOT NULL,
  `display_label` TEXT NULL,
  `category` TEXT NULL,
  `state` VARCHAR(191) NOT NULL DEFAULT '',
  `city` VARCHAR(191) NOT NULL DEFAULT '',
  `window_days` INT NOT NULL DEFAULT 30,
  `demand_score` DECIMAL(16,2) NOT NULL DEFAULT 0,
  `intent_score` DECIMAL(16,2) NOT NULL DEFAULT 0,
  `event_count` INT NOT NULL DEFAULT 0,
  `search_count` INT NOT NULL DEFAULT 0,
  `product_views` INT NOT NULL DEFAULT 0,
  `vendor_views` INT NOT NULL DEFAULT 0,
  `requirement_opens` INT NOT NULL DEFAULT 0,
  `requirement_submits` INT NOT NULL DEFAULT 0,
  `lead_count` INT NOT NULL DEFAULT 0,
  `unique_visitors` INT NOT NULL DEFAULT 0,
  `trend_percent` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `confidence` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `demand_stage` VARCHAR(32) NOT NULL DEFAULT 'LOW',
  `recommended_action` TEXT NULL,
  `top_entities` JSON NULL,
  `computed_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_behavioral_demand_window` (`demand_key`, `state`, `city`, `window_days`),
  KEY `idx_behavioral_demand_score` (`window_days`, `demand_score`),
  KEY `idx_behavioral_demand_stage` (`demand_stage`, `computed_at`),
  KEY `idx_behavioral_demand_location` (`state`, `city`, `window_days`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `behavioral_forecasts` (
  `id` CHAR(36) NOT NULL,
  `demand_key` VARCHAR(191) NOT NULL,
  `display_label` TEXT NULL,
  `state` VARCHAR(191) NOT NULL DEFAULT '',
  `city` VARCHAR(191) NOT NULL DEFAULT '',
  `window_days` INT NOT NULL DEFAULT 30,
  `forecast_7d` DECIMAL(16,2) NOT NULL DEFAULT 0,
  `forecast_30d` DECIMAL(16,2) NOT NULL DEFAULT 0,
  `trend_percent` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `confidence` DECIMAL(10,2) NOT NULL DEFAULT 0,
  `model_name` VARCHAR(191) NOT NULL DEFAULT 'weighted_behavioral_v1',
  `features` JSON NULL,
  `computed_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_behavioral_forecast_window` (`demand_key`, `state`, `city`, `window_days`),
  KEY `idx_behavioral_forecast_30d` (`window_days`, `forecast_30d`),
  KEY `idx_behavioral_forecast_location` (`state`, `city`, `window_days`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `manager_sales_division_allocations` (
  `id` CHAR(36) NOT NULL,
  `manager_user_id` CHAR(36) NULL,
  `sales_user_id` CHAR(36) NULL,
  `division_id` CHAR(36) NULL,
  `allocation_status` TEXT NULL,
  `notes` TEXT NULL,
  `allocated_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `released_at` DATETIME NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_manager_sales_division_allocations_manager_user_id` (`manager_user_id`),
  KEY `idx_manager_sales_division_allocations_sales_user_id` (`sales_user_id`),
  KEY `idx_manager_sales_division_allocations_division_id` (`division_id`),
  KEY `idx_manager_sales_division_allocations_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `marketplace_available_leads` (
  `id` CHAR(36) NOT NULL,
  `buyer_name` TEXT NULL,
  `buyer_phone` TEXT NULL,
  `title` TEXT NULL,
  `product_name` TEXT NULL,
  `quantity` TEXT NULL,
  `budget` TEXT NULL,
  `category` TEXT NULL,
  `location` TEXT NULL,
  `status` VARCHAR(191) NULL,
  `price` DECIMAL(16,2) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `vendor_id` CHAR(36) NULL,
  `buyer_email` TEXT NULL,
  `company_name` TEXT NULL,
  `product_interest` TEXT NULL,
  `message` TEXT NULL,
  `category_slug` TEXT NULL,
  `description` TEXT NULL,
  `buyer_id` CHAR(36) NULL,
  `buyer_user_id` CHAR(36) NULL,
  `micro_category_id` CHAR(36) NULL,
  `sub_category_id` CHAR(36) NULL,
  `head_category_id` CHAR(36) NULL,
  `state_id` CHAR(36) NULL,
  `city_id` CHAR(36) NULL,
  `source` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_marketplace_available_leads_status` (`status`),
  KEY `idx_marketplace_available_leads_created_at` (`created_at`),
  KEY `idx_marketplace_available_leads_vendor_id` (`vendor_id`),
  KEY `idx_marketplace_available_leads_buyer_id` (`buyer_id`),
  KEY `idx_marketplace_available_leads_buyer_user_id` (`buyer_user_id`),
  KEY `idx_marketplace_available_leads_micro_category_id` (`micro_category_id`),
  KEY `idx_marketplace_available_leads_sub_category_id` (`sub_category_id`),
  KEY `idx_marketplace_available_leads_head_category_id` (`head_category_id`),
  KEY `idx_marketplace_available_leads_state_id` (`state_id`),
  KEY `idx_marketplace_available_leads_city_id` (`city_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `micro_categories` (
  `id` CHAR(36) NOT NULL,
  `sub_category_id` CHAR(36) NULL,
  `name` TEXT NULL,
  `slug` VARCHAR(191) NULL,
  `is_active` TINYINT(1) DEFAULT 0,
  `created_by` CHAR(36) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `sort_order` INT NULL,
  `image_url` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_micro_categories_sub_category_id` (`sub_category_id`),
  KEY `idx_micro_categories_slug` (`slug`),
  KEY `idx_micro_categories_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `micro_category_meta` (
  `id` CHAR(36) NOT NULL,
  `micro_categories` CHAR(36) NULL,
  `meta_tags` TEXT NULL,
  `description` TEXT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `keywords` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_micro_category_meta_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `notifications` (
  `id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NULL,
  `type` VARCHAR(191) NULL,
  `title` TEXT NULL,
  `message` TEXT NULL,
  `link` TEXT NULL,
  `is_read` TINYINT(1) DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_notifications_user_id` (`user_id`),
  KEY `idx_notifications_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `page_status` (
  `id` CHAR(36) NOT NULL,
  `page_route` TEXT NULL,
  `page_title` TEXT NULL,
  `page_description` TEXT NULL,
  `error_message` TEXT NULL,
  `is_blanked` TINYINT(1) DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `page_name` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_page_status_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `page_seo_overrides` (
  `id` CHAR(36) NOT NULL,
  `path` VARCHAR(512) NOT NULL,
  `page_name` VARCHAR(255) NOT NULL,
  `meta_title` VARCHAR(255) NOT NULL,
  `meta_description` TEXT NOT NULL,
  `h1` VARCHAR(512) NOT NULL,
  `canonical_url` TEXT NOT NULL,
  `meta_keywords` TEXT NULL,
  `schema_kind` VARCHAR(64) NOT NULL DEFAULT 'web-page',
  `date_modified` DATE NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_page_seo_overrides_path` (`path`),
  KEY `idx_page_seo_overrides_active_updated` (`is_active`, `updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `plan_tiers` (
  `code` VARCHAR(191) NOT NULL,
  `rank_no` INT NULL,
  `seat_capacity` INT NULL,
  `max_cities` INT NULL,
  `is_exclusive` TINYINT(1) DEFAULT 0,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `platform_feedback` (
  `id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NULL,
  `subject` TEXT NULL,
  `message` TEXT NULL,
  `status` VARCHAR(191) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_platform_feedback_user_id` (`user_id`),
  KEY `idx_platform_feedback_status` (`status`),
  KEY `idx_platform_feedback_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `product_images` (
  `id` CHAR(36) NOT NULL,
  `product_id` CHAR(36) NULL,
  `image_url` TEXT NULL,
  `uploaded_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_product_images_product_id` (`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `product_videos` (
  `id` CHAR(36) NOT NULL,
  `product_id` CHAR(36) NULL,
  `video_url` TEXT NULL,
  `title` TEXT NULL,
  `thumbnail_url` TEXT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_product_videos_product_id` (`product_id`),
  KEY `idx_product_videos_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `products` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `name` TEXT NULL,
  `description` TEXT NULL,
  `price` DECIMAL(16,2) NULL,
  `moq` INT NULL,
  `stock` INT NULL,
  `category` TEXT NULL,
  `category_path` TEXT NULL,
  `images` JSON NULL,
  `status` VARCHAR(191) NULL,
  `views` INT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `metadata` JSON NULL,
  `is_service` TINYINT(1) DEFAULT 0,
  `video_url` TEXT NULL,
  `target_locations` JSON NULL,
  `micro_category_id` CHAR(36) NULL,
  `head_category_id` CHAR(36) NULL,
  `sub_category_id` CHAR(36) NULL,
  `extra_micro_categories` JSON NULL,
  `slug` VARCHAR(191) NULL,
  `pdf_url` TEXT NULL,
  `price_unit` TEXT NULL,
  `min_order_qty` INT NULL,
  `qty_unit` TEXT NULL,
  `category_other` TEXT NULL,
  `specifications` JSON NULL,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `category_slug` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_products_vendor_id` (`vendor_id`),
  KEY `idx_products_status` (`status`),
  KEY `idx_products_created_at` (`created_at`),
  KEY `idx_products_micro_category_id` (`micro_category_id`),
  KEY `idx_products_head_category_id` (`head_category_id`),
  KEY `idx_products_sub_category_id` (`sub_category_id`),
  KEY `idx_products_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `proposal_messages` (
  `id` CHAR(36) NOT NULL,
  `proposal_id` CHAR(36) NULL,
  `sender_id` CHAR(36) NULL,
  `message` TEXT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_proposal_messages_proposal_id` (`proposal_id`),
  KEY `idx_proposal_messages_sender_id` (`sender_id`),
  KEY `idx_proposal_messages_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `proposals` (
  `id` CHAR(36) NOT NULL,
  `buyer_id` CHAR(36) NULL,
  `vendor_id` CHAR(36) NULL,
  `title` TEXT NULL,
  `product_name` TEXT NULL,
  `quantity` TEXT NULL,
  `budget` DECIMAL(16,2) NULL,
  `required_by_date` DATE NULL,
  `description` TEXT NULL,
  `status` VARCHAR(191) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `buyer_email` TEXT NULL,
  `vendor_email` TEXT NULL,
  `category` TEXT NULL,
  `category_slug` TEXT NULL,
  `micro_category_id` CHAR(36) NULL,
  `sub_category_id` CHAR(36) NULL,
  `head_category_id` CHAR(36) NULL,
  `state_id` CHAR(36) NULL,
  `city_id` CHAR(36) NULL,
  `location` TEXT NULL,
  `pincode` TEXT NULL,
  `validity_days` INT NULL,
  `delivery_days` INT NULL,
  `attachment_name` TEXT NULL,
  `attachment_mime` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_proposals_buyer_id` (`buyer_id`),
  KEY `idx_proposals_vendor_id` (`vendor_id`),
  KEY `idx_proposals_status` (`status`),
  KEY `idx_proposals_created_at` (`created_at`),
  KEY `idx_proposals_micro_category_id` (`micro_category_id`),
  KEY `idx_proposals_sub_category_id` (`sub_category_id`),
  KEY `idx_proposals_head_category_id` (`head_category_id`),
  KEY `idx_proposals_state_id` (`state_id`),
  KEY `idx_proposals_city_id` (`city_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `public_vendor_plan_badges` (
  `vendor_id` CHAR(36) NOT NULL,
  `plan_name` TEXT NULL,
  `status` VARCHAR(191) NULL,
  `end_date` DATETIME NULL,
  PRIMARY KEY (`vendor_id`),
  KEY `idx_public_vendor_plan_badges_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `quotation_emails` (
  `id` CHAR(36) NOT NULL,
  `quotation_id` CHAR(36) NULL,
  `recipient_email` TEXT NULL,
  `subject` TEXT NULL,
  `status` VARCHAR(191) NULL,
  `error_message` TEXT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_quotation_emails_quotation_id` (`quotation_id`),
  KEY `idx_quotation_emails_status` (`status`),
  KEY `idx_quotation_emails_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `quotation_unregistered` (
  `id` CHAR(36) NOT NULL,
  `email` VARCHAR(191) NULL,
  `quotation_id` CHAR(36) NULL,
  `vendor_id` CHAR(36) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_quotation_unregistered_email` (`email`),
  KEY `idx_quotation_unregistered_quotation_id` (`quotation_id`),
  KEY `idx_quotation_unregistered_vendor_id` (`vendor_id`),
  KEY `idx_quotation_unregistered_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `quotes` (
  `id` CHAR(36) NOT NULL,
  `buyer_id` CHAR(36) NULL,
  `vendor_id` CHAR(36) NULL,
  `lead_id` CHAR(36) NULL,
  `quote_amount` DECIMAL(16,2) NULL,
  `message` TEXT NULL,
  `status` VARCHAR(191) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_quotes_buyer_id` (`buyer_id`),
  KEY `idx_quotes_vendor_id` (`vendor_id`),
  KEY `idx_quotes_lead_id` (`lead_id`),
  KEY `idx_quotes_status` (`status`),
  KEY `idx_quotes_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `referral_plan_rules` (
  `id` CHAR(36) NOT NULL,
  `plan_id` CHAR(36) NULL,
  `is_enabled` TINYINT(1) DEFAULT 0,
  `discount_type` TEXT NULL,
  `discount_value` DECIMAL(16,2) NULL,
  `discount_cap` DECIMAL(16,2) NULL,
  `reward_type` TEXT NULL,
  `reward_value` DECIMAL(16,2) NULL,
  `reward_cap` DECIMAL(16,2) NULL,
  `valid_from` DATETIME NULL,
  `valid_to` DATETIME NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_referral_plan_rules_plan_id` (`plan_id`),
  KEY `idx_referral_plan_rules_plan_id` (`plan_id`),
  KEY `idx_referral_plan_rules_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `referral_program_settings` (
  `config_key` VARCHAR(191) NOT NULL,
  `is_enabled` TINYINT(1) DEFAULT 0,
  `first_paid_plan_only` TINYINT(1) DEFAULT 0,
  `allow_coupon_stack` TINYINT(1) DEFAULT 0,
  `min_plan_amount` DECIMAL(16,2) NULL,
  `min_cashout_amount` DECIMAL(16,2) NULL,
  `reward_hold_days` INT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`config_key`),
  KEY `idx_referral_program_settings_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `regions` (
  `code` VARCHAR(191) NOT NULL,
  `name` TEXT NULL,
  `sort_order` INT NULL,
  `is_active` TINYINT(1) DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`code`),
  KEY `idx_regions_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `requirements` (
  `id` CHAR(36) NOT NULL,
  `name` TEXT NULL,
  `email` VARCHAR(191) NULL,
  `phone` VARCHAR(191) NULL,
  `company_name` TEXT NULL,
  `requirement_description` TEXT NULL,
  `budget` DECIMAL(16,2) NULL,
  `timeline` TEXT NULL,
  `state_id` CHAR(36) NULL,
  `city_id` CHAR(36) NULL,
  `status` VARCHAR(191) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_requirements_email` (`email`),
  KEY `idx_requirements_state_id` (`state_id`),
  KEY `idx_requirements_city_id` (`city_id`),
  KEY `idx_requirements_status` (`status`),
  KEY `idx_requirements_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `role_permissions` (
  `id` CHAR(36) NOT NULL,
  `role` VARCHAR(191) NULL,
  `module` TEXT NULL,
  `can_view` TINYINT(1) DEFAULT 0,
  `can_create` TINYINT(1) DEFAULT 0,
  `can_edit` TINYINT(1) DEFAULT 0,
  `can_delete` TINYINT(1) DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_role_permissions_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sales_vendor_engagements` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `lead_id` CHAR(36) NULL,
  `sales_user_id` CHAR(36) NULL,
  `manager_user_id` CHAR(36) NULL,
  `vp_user_id` CHAR(36) NULL,
  `division_id` CHAR(36) NULL,
  `plan_id` CHAR(36) NULL,
  `sales_code` VARCHAR(191) NULL,
  `plan_share_url` TEXT NULL,
  `channel` VARCHAR(191) NULL,
  `engagement_type` TEXT NULL,
  `status` VARCHAR(191) NULL,
  `notes` TEXT NULL,
  `next_follow_up_at` DATETIME NULL,
  `is_contact_unmasked` TINYINT(1) DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_sales_vendor_engagements_vendor_id` (`vendor_id`),
  KEY `idx_sales_vendor_engagements_lead_id` (`lead_id`),
  KEY `idx_sales_vendor_engagements_sales_user_id` (`sales_user_id`),
  KEY `idx_sales_vendor_engagements_manager_user_id` (`manager_user_id`),
  KEY `idx_sales_vendor_engagements_vp_user_id` (`vp_user_id`),
  KEY `idx_sales_vendor_engagements_division_id` (`division_id`),
  KEY `idx_sales_vendor_engagements_plan_id` (`plan_id`),
  KEY `idx_sales_vendor_engagements_sales_code` (`sales_code`),
  KEY `idx_sales_vendor_engagements_status` (`status`),
  KEY `idx_sales_vendor_engagements_next_follow_up_at` (`next_follow_up_at`),
  KEY `idx_sales_vendor_engagements_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `search360_cases` (
  `id` CHAR(36) NOT NULL,
  `ticket_id` CHAR(36) NULL,
  `vendor_id` CHAR(36) NULL,
  `case_type` VARCHAR(64) NULL,
  `target_team` VARCHAR(64) NULL,
  `source_role` VARCHAR(64) NULL,
  `source_user_id` CHAR(36) NULL,
  `source_employee_id` CHAR(36) NULL,
  `source_email` VARCHAR(191) NULL,
  `subject` TEXT NULL,
  `note` TEXT NULL,
  `priority` VARCHAR(32) NULL,
  `status` VARCHAR(32) NULL,
  `region_state_id` CHAR(36) NULL,
  `region_state` TEXT NULL,
  `resolution_note` TEXT NULL,
  `resolved_by` CHAR(36) NULL,
  `resolved_by_role` VARCHAR(64) NULL,
  `resolved_at` DATETIME NULL,
  `metadata` JSON NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_search360_cases_ticket_id` (`ticket_id`),
  KEY `idx_search360_cases_vendor_id` (`vendor_id`),
  KEY `idx_search360_cases_target_team` (`target_team`),
  KEY `idx_search360_cases_status` (`status`),
  KEY `idx_search360_cases_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `states` (
  `id` CHAR(36) NOT NULL,
  `name` TEXT NULL,
  `slug` VARCHAR(191) NULL,
  `is_active` TINYINT(1) DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `region_code` VARCHAR(191) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_states_slug` (`slug`),
  KEY `idx_states_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sub_categories` (
  `id` CHAR(36) NOT NULL,
  `head_category_id` CHAR(36) NULL,
  `name` TEXT NULL,
  `slug` VARCHAR(191) NULL,
  `is_active` TINYINT(1) DEFAULT 0,
  `created_by` CHAR(36) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `image_url` TEXT NULL,
  `description` TEXT NULL,
  `meta_tags` TEXT NULL,
  `keywords` TEXT NULL,
  `sort_order` INT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_sub_categories_head_category_id` (`head_category_id`),
  KEY `idx_sub_categories_slug` (`slug`),
  KEY `idx_sub_categories_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `subscription_extension_requests` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `vendor_name` TEXT NULL,
  `vendor_state` TEXT NULL,
  `reason` TEXT NULL,
  `extension_days` INT NULL,
  `current_level` TEXT NULL,
  `status` VARCHAR(191) NULL,
  `sales_note` TEXT NULL,
  `manager_note` TEXT NULL,
  `vp_note` TEXT NULL,
  `admin_note` TEXT NULL,
  `created_by_email` TEXT NULL,
  `forwarded_by_manager` TEXT NULL,
  `forwarded_by_vp` TEXT NULL,
  `resolved_by` TEXT NULL,
  `extension_granted_days` INT NULL,
  `resolved_at` DATETIME NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_subscription_extension_requests_vendor_id` (`vendor_id`),
  KEY `idx_subscription_extension_requests_status` (`status`),
  KEY `idx_subscription_extension_requests_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `suggestions` (
  `id` CHAR(36) NOT NULL,
  `buyer_id` CHAR(36) NULL,
  `subject` TEXT NULL,
  `message` TEXT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `buyer_email` TEXT NULL,
  `status` VARCHAR(191) NULL,
  `admin_note` TEXT NULL,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_suggestions_buyer_id` (`buyer_id`),
  KEY `idx_suggestions_created_at` (`created_at`),
  KEY `idx_suggestions_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `superadmin_users` (
  `id` CHAR(36) NOT NULL,
  `email` VARCHAR(191) NULL,
  `password_hash` TEXT NULL,
  `role` VARCHAR(191) NULL,
  `is_active` TINYINT(1) DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `last_login` DATETIME NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_superadmin_users_email` (`email`),
  KEY `idx_superadmin_users_email` (`email`),
  KEY `idx_superadmin_users_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `support_tickets` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `subject` TEXT NULL,
  `status` VARCHAR(191) NULL,
  `last_reply_at` DATETIME NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `buyer_id` CHAR(36) NULL,
  `description` TEXT NULL,
  `category` TEXT NULL,
  `priority` TEXT NULL,
  `ticket_display_id` VARCHAR(191) NULL,
  `attachments` JSON NULL,
  `resolved_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  KEY `idx_support_tickets_vendor_id` (`vendor_id`),
  KEY `idx_support_tickets_status` (`status`),
  KEY `idx_support_tickets_created_at` (`created_at`),
  KEY `idx_support_tickets_buyer_id` (`buyer_id`),
  KEY `idx_support_tickets_ticket_display_id` (`ticket_display_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `system_config` (
  `id` CHAR(36) NOT NULL,
  `config_key` VARCHAR(191) NULL,
  `maintenance_mode` TINYINT(1) DEFAULT 0,
  `maintenance_message` TEXT NULL,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `updated_by` CHAR(36) NULL,
  `allow_vendor_registration` TINYINT(1) DEFAULT 0,
  `commission_rate` DECIMAL(16,2) NULL,
  `max_upload_size_mb` INT NULL,
  `public_notice_enabled` TINYINT(1) DEFAULT 0,
  `public_notice_message` TEXT NULL,
  `public_notice_variant` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_system_config_key_updated` (`config_key`, `updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ticket_messages` (
  `id` CHAR(36) NOT NULL,
  `ticket_id` CHAR(36) NULL,
  `sender_id` CHAR(36) NULL,
  `sender_type` TEXT NULL,
  `message` TEXT NULL,
  `attachments` JSON NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ticket_messages_ticket_id` (`ticket_id`),
  KEY `idx_ticket_messages_sender_id` (`sender_id`),
  KEY `idx_ticket_messages_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `users` (
  `id` CHAR(36) NOT NULL,
  `email` VARCHAR(191) NULL,
  `password_hash` TEXT NULL,
  `full_name` TEXT NULL,
  `role` VARCHAR(191) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `phone` VARCHAR(191) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_email` (`email`),
  KEY `idx_users_email` (`email`),
  KEY `idx_users_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_additional_leads` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `leads_purchased` INT NULL,
  `leads_remaining` INT NULL,
  `purchase_date` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `expiry_date` DATETIME NULL,
  `amount_paid` DECIMAL(16,2) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_vendor_additional_leads_vendor_id` (`vendor_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_bank_details` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `account_number` TEXT NULL,
  `account_holder` TEXT NULL,
  `bank_name` TEXT NULL,
  `ifsc_code` VARCHAR(191) NULL,
  `branch_name` TEXT NULL,
  `is_primary` TINYINT(1) DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_vendor_bank_details_vendor_id` (`vendor_id`),
  KEY `idx_vendor_bank_details_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_contact_persons` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `name` TEXT NULL,
  `designation` TEXT NULL,
  `mobile_number` TEXT NULL,
  `email` VARCHAR(191) NULL,
  `is_primary` TINYINT(1) DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_vendor_contact_persons_vendor_id` (`vendor_id`),
  KEY `idx_vendor_contact_persons_email` (`email`),
  KEY `idx_vendor_contact_persons_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_coupon_usages` (
  `id` CHAR(36) NOT NULL,
  `coupon_id` CHAR(36) NULL,
  `payment_id` CHAR(36) NULL,
  `vendor_id` CHAR(36) NULL,
  `plan_id` CHAR(36) NULL,
  `discount_amount` DECIMAL(16,2) NULL,
  `net_amount` DECIMAL(16,2) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_vendor_coupon_usages_coupon_id` (`coupon_id`),
  KEY `idx_vendor_coupon_usages_payment_id` (`payment_id`),
  KEY `idx_vendor_coupon_usages_vendor_id` (`vendor_id`),
  KEY `idx_vendor_coupon_usages_plan_id` (`plan_id`),
  KEY `idx_vendor_coupon_usages_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_division_map` (
  `vendor_id` CHAR(36) NOT NULL,
  `division_id` CHAR(36) NOT NULL,
  `mapped_by_user_id` CHAR(36) NULL,
  `mapping_source` TEXT NULL,
  `confidence` DECIMAL(16,2) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`vendor_id`, `division_id`),
  KEY `idx_vendor_division_map_mapped_by_user_id` (`mapped_by_user_id`),
  KEY `idx_vendor_division_map_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_documents` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `document_type` TEXT NULL,
  `document_url` TEXT NULL,
  `original_name` TEXT NULL,
  `uploaded_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `verification_status` TEXT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_vendor_documents_vendor_id` (`vendor_id`),
  KEY `idx_vendor_documents_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_lead_quota` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `plan_id` CHAR(36) NULL,
  `daily_used` INT NULL,
  `daily_limit` INT NULL,
  `weekly_used` INT NULL,
  `weekly_limit` INT NULL,
  `yearly_used` INT NULL,
  `yearly_limit` INT NULL,
  `last_reset_date` DATETIME NULL,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_vendor_lead_quota_vendor_id` (`vendor_id`),
  KEY `idx_vendor_lead_quota_vendor_id` (`vendor_id`),
  KEY `idx_vendor_lead_quota_plan_id` (`plan_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_lead_quota_backup_20260222` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `plan_id` CHAR(36) NULL,
  `daily_used` INT NULL,
  `daily_limit` INT NULL,
  `weekly_used` INT NULL,
  `weekly_limit` INT NULL,
  `yearly_used` INT NULL,
  `yearly_limit` INT NULL,
  `last_reset_date` DATETIME NULL,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_vendor_lead_quota_backup_20260222_vendor_id` (`vendor_id`),
  KEY `idx_vendor_lead_quota_backup_20260222_plan_id` (`plan_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_messages` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `sender_name` TEXT NULL,
  `sender_email` TEXT NULL,
  `sender_phone` TEXT NULL,
  `subject` TEXT NULL,
  `message` TEXT NULL,
  `is_read` TINYINT(1) DEFAULT 0,
  `is_replied` TINYINT(1) DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_vendor_messages_vendor_id` (`vendor_id`),
  KEY `idx_vendor_messages_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_otp_codes` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `otp_code` VARCHAR(191) NULL,
  `email` VARCHAR(191) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `expires_at` DATETIME NULL,
  `is_used` TINYINT(1) DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_vendor_otp_codes_vendor_id` (`vendor_id`),
  KEY `idx_vendor_otp_codes_email` (`email`),
  KEY `idx_vendor_otp_codes_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_payments` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `amount` DECIMAL(16,2) NULL,
  `description` TEXT NULL,
  `status` VARCHAR(191) NULL,
  `payment_method` TEXT NULL,
  `transaction_id` VARCHAR(191) NULL,
  `payment_date` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `invoice_url` TEXT NULL,
  `plan_id` CHAR(36) NULL,
  `subscription_id` CHAR(36) NULL,
  `coupon_code` VARCHAR(191) NULL,
  `discount_amount` DECIMAL(16,2) NULL,
  `net_amount` DECIMAL(16,2) NULL,
  `offer_type` TEXT NULL,
  `offer_code` VARCHAR(191) NULL,
  `referral_id` CHAR(36) NULL,
  `sales_code` VARCHAR(191) NULL,
  `sales_user_id` CHAR(36) NULL,
  `sales_engagement_id` CHAR(36) NULL,
  `billing_cycle` VARCHAR(32) NOT NULL DEFAULT 'YEARLY',
  `plan_duration_days` INT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_vendor_payments_vendor_id` (`vendor_id`),
  KEY `idx_vendor_payments_status` (`status`),
  KEY `idx_vendor_payments_transaction_id` (`transaction_id`),
  KEY `idx_vendor_payments_plan_id` (`plan_id`),
  KEY `idx_vendor_payments_subscription_id` (`subscription_id`),
  KEY `idx_vendor_payments_referral_id` (`referral_id`),
  KEY `idx_vendor_payments_sales_code` (`sales_code`),
  KEY `idx_vendor_payments_sales_user_id` (`sales_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_plan_coupons` (
  `id` CHAR(36) NOT NULL,
  `code` VARCHAR(191) NULL,
  `discount_type` TEXT NULL,
  `value` DECIMAL(16,2) NULL,
  `plan_id` CHAR(36) NULL,
  `vendor_id` CHAR(36) NULL,
  `max_uses` INT NULL,
  `used_count` INT NULL,
  `expires_at` DATETIME NULL,
  `is_active` TINYINT(1) DEFAULT 0,
  `metadata` JSON NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `created_by` CHAR(36) NULL,
  `approval_status` TEXT NULL,
  `rejection_reason` TEXT NULL,
  `approved_by` TEXT NULL,
  `approved_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  KEY `idx_vendor_plan_coupons_plan_id` (`plan_id`),
  KEY `idx_vendor_plan_coupons_vendor_id` (`vendor_id`),
  KEY `idx_vendor_plan_coupons_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_plan_slots` (
  `id` CHAR(36) NOT NULL,
  `subscription_id` CHAR(36) NULL,
  `vendor_id` CHAR(36) NULL,
  `plan_code` VARCHAR(191) NULL,
  `category_id` CHAR(36) NULL,
  `city_id` CHAR(36) NULL,
  `seat_no` INT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_vendor_plan_slots_subscription_id` (`subscription_id`),
  KEY `idx_vendor_plan_slots_vendor_id` (`vendor_id`),
  KEY `idx_vendor_plan_slots_category_id` (`category_id`),
  KEY `idx_vendor_plan_slots_city_id` (`city_id`),
  KEY `idx_vendor_plan_slots_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_plan_subscriptions` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `plan_id` CHAR(36) NULL,
  `start_date` DATETIME NULL,
  `end_date` DATETIME NULL,
  `status` VARCHAR(191) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `plan_duration_days` INT NULL,
  `renewal_notification_sent` TINYINT(1) DEFAULT 0,
  `renewal_notification_sent_at` DATETIME NULL,
  `auto_renewal_enabled` TINYINT(1) DEFAULT 0,
  `sales_code` VARCHAR(191) NULL,
  `sales_user_id` CHAR(36) NULL,
  `billing_cycle` VARCHAR(32) NOT NULL DEFAULT 'YEARLY',
  PRIMARY KEY (`id`),
  KEY `idx_vendor_plan_subscriptions_vendor_id` (`vendor_id`),
  KEY `idx_vendor_plan_subscriptions_plan_id` (`plan_id`),
  KEY `idx_vendor_plan_subscriptions_status` (`status`),
  KEY `idx_vendor_plan_subscriptions_sales_code` (`sales_code`),
  KEY `idx_vendor_plan_subscriptions_sales_user_id` (`sales_user_id`),
  KEY `idx_vendor_plan_subscriptions_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_plans` (
  `id` CHAR(36) NOT NULL,
  `name` TEXT NULL,
  `daily_limit` INT NULL,
  `weekly_limit` INT NULL,
  `yearly_limit` INT NULL,
  `member_limit` INT NULL,
  `price` DECIMAL(16,2) NULL,
  `features` JSON NULL,
  `is_active` TINYINT(1) DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `description` TEXT NULL,
  `duration_days` INT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_vendor_plans_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_preferences` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `preferred_micro_categories` JSON NULL,
  `preferred_states` JSON NULL,
  `preferred_districts` JSON NULL,
  `preferred_cities` JSON NULL,
  `min_budget` DECIMAL(16,2) NULL,
  `max_budget` DECIMAL(16,2) NULL,
  `auto_lead_filter` TINYINT(1) DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_vendor_preferences_vendor_id` (`vendor_id`),
  KEY `idx_vendor_preferences_vendor_id` (`vendor_id`),
  KEY `idx_vendor_preferences_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_referral_cashout_requests` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `requested_amount` DECIMAL(16,2) NULL,
  `status` VARCHAR(191) NULL,
  `bank_detail_id` CHAR(36) NULL,
  `bank_snapshot` JSON NULL,
  `notes` TEXT NULL,
  `approved_by_user_id` CHAR(36) NULL,
  `approved_at` DATETIME NULL,
  `paid_by_user_id` CHAR(36) NULL,
  `paid_at` DATETIME NULL,
  `utr_number` TEXT NULL,
  `receipt_url` TEXT NULL,
  `rejection_reason` TEXT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_vendor_referral_cashout_requests_vendor_id` (`vendor_id`),
  KEY `idx_vendor_referral_cashout_requests_status` (`status`),
  KEY `idx_vendor_referral_cashout_requests_bank_detail_id` (`bank_detail_id`),
  KEY `idx_vendor_referral_cashout_requests_approved_by_user_id` (`approved_by_user_id`),
  KEY `idx_vendor_referral_cashout_requests_paid_by_user_id` (`paid_by_user_id`),
  KEY `idx_vendor_referral_cashout_requests_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_referral_profiles` (
  `vendor_id` CHAR(36) NOT NULL,
  `referral_code` VARCHAR(191) NULL,
  `is_active` TINYINT(1) DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`vendor_id`),
  UNIQUE KEY `uq_vendor_referral_profiles_referral_code` (`referral_code`),
  KEY `idx_vendor_referral_profiles_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_referral_wallet_ledger` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `referral_id` CHAR(36) NULL,
  `payment_id` CHAR(36) NULL,
  `cashout_request_id` CHAR(36) NULL,
  `entry_type` TEXT NULL,
  `amount` DECIMAL(16,2) NULL,
  `status` VARCHAR(191) NULL,
  `hold_until` DATETIME NULL,
  `reference_key` VARCHAR(191) NULL,
  `meta` JSON NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_vendor_referral_wallet_ledger_reference_key` (`reference_key`),
  KEY `idx_vendor_referral_wallet_ledger_vendor_id` (`vendor_id`),
  KEY `idx_vendor_referral_wallet_ledger_referral_id` (`referral_id`),
  KEY `idx_vendor_referral_wallet_ledger_payment_id` (`payment_id`),
  KEY `idx_vendor_referral_wallet_ledger_cashout_request_id` (`cashout_request_id`),
  KEY `idx_vendor_referral_wallet_ledger_status` (`status`),
  KEY `idx_vendor_referral_wallet_ledger_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_referral_wallets` (
  `vendor_id` CHAR(36) NOT NULL,
  `available_balance` DECIMAL(16,2) NULL,
  `pending_balance` DECIMAL(16,2) NULL,
  `lifetime_earned` DECIMAL(16,2) NULL,
  `lifetime_paid_out` DECIMAL(16,2) NULL,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`vendor_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_referrals` (
  `id` CHAR(36) NOT NULL,
  `referrer_vendor_id` CHAR(36) NULL,
  `referred_vendor_id` CHAR(36) NULL,
  `referral_code` VARCHAR(191) NULL,
  `status` VARCHAR(191) NULL,
  `qualified_payment_id` CHAR(36) NULL,
  `qualified_at` DATETIME NULL,
  `rewarded_at` DATETIME NULL,
  `rejection_reason` TEXT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_vendor_referrals_referrer_vendor_id` (`referrer_vendor_id`),
  KEY `idx_vendor_referrals_referred_vendor_id` (`referred_vendor_id`),
  KEY `idx_vendor_referrals_status` (`status`),
  KEY `idx_vendor_referrals_qualified_payment_id` (`qualified_payment_id`),
  KEY `idx_vendor_referrals_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_services` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `name` TEXT NULL,
  `service_name` TEXT NULL,
  `title` TEXT NULL,
  `category` TEXT NULL,
  `service_type` TEXT NULL,
  `description` TEXT NULL,
  `details` TEXT NULL,
  `short_description` TEXT NULL,
  `price` DECIMAL(16,2) NULL,
  `rate` DECIMAL(16,2) NULL,
  `price_unit` TEXT NULL,
  `image` TEXT NULL,
  `cover_image` TEXT NULL,
  `images` JSON NULL,
  `is_active` TINYINT(1) DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_vendor_services_vendor_id` (`vendor_id`),
  KEY `idx_vendor_services_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendor_subscriptions` (
  `id` CHAR(36) NOT NULL,
  `vendor_id` CHAR(36) NULL,
  `service_id` CHAR(36) NULL,
  `status` VARCHAR(191) NULL,
  `start_date` DATETIME NULL,
  `end_date` DATETIME NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_vendor_subscriptions_vendor_id` (`vendor_id`),
  KEY `idx_vendor_subscriptions_service_id` (`service_id`),
  KEY `idx_vendor_subscriptions_status` (`status`),
  KEY `idx_vendor_subscriptions_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vendors` (
  `id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NULL,
  `company_name` TEXT NULL,
  `email` VARCHAR(191) NULL,
  `phone` VARCHAR(191) NULL,
  `address` TEXT NULL,
  `kyc_status` TEXT NULL,
  `profile_completion` INT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `owner_name` TEXT NULL,
  `city` TEXT NULL,
  `state` TEXT NULL,
  `gst_number` TEXT NULL,
  `pan_number` TEXT NULL,
  `state_id` CHAR(36) NULL,
  `district_id` CHAR(36) NULL,
  `city_id` CHAR(36) NULL,
  `profile_image` TEXT NULL,
  `vendor_id` VARCHAR(191) NULL,
  `created_by_user_id` CHAR(36) NULL,
  `generated_password_hash` TEXT NULL,
  `is_password_temporary` TINYINT(1) DEFAULT 0,
  `last_name` TEXT NULL,
  `pincode` TEXT NULL,
  `aadhar_number` TEXT NULL,
  `kyc_completed` TINYINT(1) DEFAULT 0,
  `registered_address` TEXT NULL,
  `verification_badge` TINYINT(1) DEFAULT 0,
  `assigned_to` CHAR(36) NULL,
  `is_active` TINYINT(1) DEFAULT 0,
  `all_india_visibility` TINYINT(1) NOT NULL DEFAULT 0,
  `is_verified` TINYINT(1) DEFAULT 0,
  `verified_at` DATETIME NULL,
  `website_url` TEXT NULL,
  `social_media` JSON NULL,
  `trust_score` INT NULL,
  `seller_rating` DECIMAL(16,2) NULL,
  `response_time` TEXT NULL,
  `cancellation_rate` DECIMAL(16,2) NULL,
  `return_rate` DECIMAL(16,2) NULL,
  `dispute_resolution` DECIMAL(16,2) NULL,
  `annual_turnover` TEXT NULL,
  `primary_business_type` TEXT NULL,
  `secondary_business` TEXT NULL,
  `cin_number` TEXT NULL,
  `gst_registration_date` DATE NULL,
  `secondary_email` TEXT NULL,
  `secondary_phone` TEXT NULL,
  `landline_number` TEXT NULL,
  `iec_code` VARCHAR(191) NULL,
  `year_of_establishment` INT NULL,
  `owner_designation` TEXT NULL,
  `company_size` TEXT NULL,
  `tan_number` TEXT NULL,
  `rejection_reason` TEXT NULL,
  `account_status` TEXT NULL,
  `is_suspended` TEXT NULL,
  `suspended_at` TEXT NULL,
  `suspension_message` TEXT NULL,
  `terminated_at` TEXT NULL,
  `business_description` TEXT NULL,
  `gst_verified` TINYINT(1) DEFAULT 0,
  `established_year` INT NULL,
  `years_in_business` INT NULL,
  `response_rate` INT NULL,
  `slug` VARCHAR(191) NULL,
  `portfolio_settings` JSON NULL,
  `status` VARCHAR(191) NULL,
  `suspension_at` DATETIME NULL,
  `suspension_reason` TEXT NULL,
  `terminated_reason` TEXT NULL,
  `collection_groups` JSON NULL,
  `collection_assignments` JSON NULL,
  `collection_notes` JSON NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_vendors_vendor_id` (`vendor_id`),
  KEY `idx_vendors_user_id` (`user_id`),
  KEY `idx_vendors_email` (`email`),
  KEY `idx_vendors_created_at` (`created_at`),
  KEY `idx_vendors_state_id` (`state_id`),
  KEY `idx_vendors_city_id` (`city_id`),
  KEY `idx_vendors_vendor_id` (`vendor_id`),
  KEY `idx_vendors_created_by_user_id` (`created_by_user_id`),
  KEY `idx_vendors_slug` (`slug`),
  KEY `idx_vendors_active_all_india` (`is_active`, `all_india_visibility`),
  KEY `idx_vendors_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `view_category_hierarchy` (
  `head_id` CHAR(36) NOT NULL,
  `head_name` TEXT NULL,
  `head_slug` TEXT NULL,
  `head_image` TEXT NULL,
  `sub_categories` JSON NULL,
  PRIMARY KEY (`head_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `vp_manager_division_allocations` (
  `id` CHAR(36) NOT NULL,
  `vp_user_id` CHAR(36) NULL,
  `manager_user_id` CHAR(36) NULL,
  `division_id` CHAR(36) NULL,
  `allocation_status` TEXT NULL,
  `notes` TEXT NULL,
  `allocated_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `released_at` DATETIME NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_vp_manager_division_allocations_vp_user_id` (`vp_user_id`),
  KEY `idx_vp_manager_division_allocations_manager_user_id` (`manager_user_id`),
  KEY `idx_vp_manager_division_allocations_division_id` (`division_id`),
  KEY `idx_vp_manager_division_allocations_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
