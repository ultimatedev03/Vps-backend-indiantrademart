const DIRECT_CHANNEL = 'DIRECT';
const SALES_ASSISTED_CHANNEL = 'SALES_ASSISTED';

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

export const asPlanObject = (value) => {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
};

const normalizeBool = (value, fallback = false) => {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const token = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(token)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(token)) return false;
  return fallback;
};

const normalizePositiveInt = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
};

const normalizeTier = (value = '') => {
  const token = String(value || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (['CERTIFIED', 'SILVER', 'GOLD', 'DIAMOND', 'PLATINUM'].includes(token)) return token;
  return '';
};

const inferTierFromPlanName = (planName = '') => {
  const name = String(planName || '').toLowerCase();
  if (name.includes('diamond') || name.includes('dimond')) return 'DIAMOND';
  if (name.includes('gold')) return 'GOLD';
  if (name.includes('silver')) return 'SILVER';
  if (name.includes('certified') || name.includes('verified')) return 'CERTIFIED';
  return '';
};

const normalizeChannel = (value = '', fallback = DIRECT_CHANNEL) => {
  const token = String(value || '').trim().toUpperCase().replace(/[^A-Z_]/g, '_');
  if (['SALES', 'SALES_ASSISTED', 'ASSISTED', 'MANUAL'].includes(token)) return SALES_ASSISTED_CHANNEL;
  if (['DIRECT', 'SELF_SERVE', 'SELF_SERVICE', 'ONLINE'].includes(token)) return DIRECT_CHANNEL;
  return fallback;
};

export const normalizePlanFeatures = (features = {}, payload = {}) => {
  const next = {
    ...asPlanObject(features),
    ...asPlanObject(payload?.features),
  };

  const incoming = asPlanObject(payload?.features);

  const purchase = {
    ...asPlanObject(features?.purchase),
    ...asPlanObject(incoming?.purchase),
  };
  if (hasOwn(payload, 'purchase_channel')) purchase.channel = payload.purchase_channel;
  if (hasOwn(payload, 'public_purchase_enabled')) purchase.public_purchase_enabled = payload.public_purchase_enabled;
  if (hasOwn(payload, 'sales_assisted')) purchase.sales_assisted = payload.sales_assisted;
  if (hasOwn(payload, 'sales_cta_label')) purchase.cta_label = payload.sales_cta_label;
  if (Object.keys(purchase).length > 0) {
    const channel = normalizeChannel(
      purchase.channel,
      normalizeBool(purchase.sales_assisted, false) ? SALES_ASSISTED_CHANNEL : DIRECT_CHANNEL
    );
    purchase.channel = channel;
    purchase.sales_assisted = channel === SALES_ASSISTED_CHANNEL || normalizeBool(purchase.sales_assisted, false);
    purchase.public_purchase_enabled =
      channel === SALES_ASSISTED_CHANNEL
        ? false
        : normalizeBool(purchase.public_purchase_enabled, true);
    next.purchase = purchase;
  }

  const portfolio = {
    ...asPlanObject(features?.portfolio),
    ...asPlanObject(incoming?.portfolio),
  };
  if (hasOwn(payload, 'portfolio_template')) portfolio.template = payload.portfolio_template;
  if (hasOwn(payload, 'portfolio_customizable')) portfolio.customizable = payload.portfolio_customizable;
  if (hasOwn(payload, 'custom_url_enabled')) portfolio.custom_url = payload.custom_url_enabled;
  if (hasOwn(payload, 'portfolio_custom_sections')) portfolio.custom_sections = payload.portfolio_custom_sections;
  if (hasOwn(payload, 'sitemap_customization')) portfolio.sitemap_customization = payload.sitemap_customization;
  if (hasOwn(payload, 'sitemap_url_boost')) portfolio.sitemap_url_boost = payload.sitemap_url_boost;
  if (Object.keys(portfolio).length > 0) {
    portfolio.enabled = normalizeBool(portfolio.enabled, true);
    portfolio.template = String(portfolio.template || 'STANDARD').trim().toUpperCase() === 'PREMIUM'
      ? 'PREMIUM'
      : 'STANDARD';
    portfolio.customizable = normalizeBool(portfolio.customizable, false);
    portfolio.custom_url = normalizeBool(portfolio.custom_url, false);
    portfolio.custom_sections = normalizeBool(portfolio.custom_sections, false);
    portfolio.sitemap_customization = normalizeBool(portfolio.sitemap_customization, false);
    portfolio.sitemap_url_boost = normalizePositiveInt(portfolio.sitemap_url_boost, 0);
    next.portfolio = portfolio;
  }

  const certificate = {
    ...asPlanObject(features?.certificate),
    ...asPlanObject(incoming?.certificate),
  };
  if (hasOwn(payload, 'certificate_enabled')) certificate.enabled = payload.certificate_enabled;
  if (hasOwn(payload, 'certificate_tier')) certificate.tier = payload.certificate_tier;
  if (hasOwn(payload, 'certificate_title')) certificate.title = payload.certificate_title;
  if (hasOwn(payload, 'certificate_label')) certificate.label = payload.certificate_label;
  if (Object.keys(certificate).length > 0) {
    const tier = normalizeTier(certificate.tier || certificate.label || '');
    certificate.enabled = normalizeBool(certificate.enabled, Boolean(tier));
    if (tier) certificate.tier = tier;
    certificate.printable = normalizeBool(certificate.printable, true);
    certificate.shop_display = normalizeBool(certificate.shop_display, true);
    next.certificate = certificate;
  }

  const seo = {
    ...asPlanObject(features?.seo),
    ...asPlanObject(incoming?.seo),
  };
  if (hasOwn(payload, 'seo_enabled')) seo.enabled = payload.seo_enabled;
  if (hasOwn(payload, 'seo_url_aliases')) seo.url_aliases = payload.seo_url_aliases;
  if (hasOwn(payload, 'seo_city_category_pages')) seo.city_category_pages = payload.seo_city_category_pages;
  if (Object.keys(seo).length > 0) {
    seo.enabled = normalizeBool(seo.enabled, false);
    seo.portfolio_schema = normalizeBool(seo.portfolio_schema, seo.enabled);
    seo.sitemap = normalizeBool(seo.sitemap, seo.enabled);
    seo.custom_keywords = normalizeBool(seo.custom_keywords, false);
    seo.url_aliases = normalizePositiveInt(seo.url_aliases, 0);
    seo.city_category_pages = normalizePositiveInt(seo.city_category_pages, 0);
    next.seo = seo;
  }

  return next;
};

export const getPlanEntitlements = (plan = null) => {
  const features = normalizePlanFeatures(asPlanObject(plan?.features));
  const name = String(plan?.name || '').trim();
  const price = Number(plan?.price || 0);
  const inferredTier = inferTierFromPlanName(name);

  const purchaseRaw = asPlanObject(features.purchase);
  const hasExplicitPurchaseControls = Object.keys(purchaseRaw).length > 0;
  const channel = normalizeChannel(
    purchaseRaw.channel,
    normalizeBool(purchaseRaw.sales_assisted, false) ? SALES_ASSISTED_CHANNEL : DIRECT_CHANNEL
  );
  const inferredSalesAssisted =
    !hasExplicitPurchaseControls &&
    (price >= 75000 || ['SILVER', 'GOLD', 'DIAMOND', 'PLATINUM'].includes(inferredTier));
  const salesAssisted =
    channel === SALES_ASSISTED_CHANNEL ||
    normalizeBool(purchaseRaw.sales_assisted, false) ||
    purchaseRaw.public_purchase_enabled === false ||
    inferredSalesAssisted;
  const publicPurchaseEnabled = !salesAssisted && normalizeBool(purchaseRaw.public_purchase_enabled, true);

  const portfolioRaw = asPlanObject(features.portfolio);
  const certificateRaw = asPlanObject(features.certificate);
  const seoRaw = asPlanObject(features.seo);
  const certificateTier = normalizeTier(certificateRaw.tier || inferredTier);
  const premiumByFallback =
    price >= 100000 ||
    ['premium', 'enterprise', 'diamond', 'dimond', 'platinum', 'gold', 'silver'].some((word) =>
      name.toLowerCase().includes(word)
    );

  const portfolioTemplate = String(portfolioRaw.template || '').trim().toUpperCase() === 'PREMIUM'
    ? 'PREMIUM'
    : premiumByFallback
      ? 'PREMIUM'
      : 'STANDARD';

  const portfolio = {
    enabled: normalizeBool(portfolioRaw.enabled, true),
    template: portfolioTemplate,
    premium: portfolioTemplate === 'PREMIUM',
    customizable: normalizeBool(portfolioRaw.customizable, salesAssisted && portfolioTemplate === 'PREMIUM'),
    custom_url: normalizeBool(portfolioRaw.custom_url, salesAssisted),
    custom_sections: normalizeBool(portfolioRaw.custom_sections, salesAssisted),
    sitemap_customization: normalizeBool(portfolioRaw.sitemap_customization, salesAssisted),
    sitemap_url_boost: normalizePositiveInt(portfolioRaw.sitemap_url_boost, salesAssisted ? 100 : 0),
    showcase_label: String(portfolioRaw.showcase_label || (portfolioTemplate === 'PREMIUM' ? 'Premium portfolio' : 'Company profile')).trim(),
  };

  const certificate = {
    enabled: normalizeBool(certificateRaw.enabled, Boolean(certificateTier && salesAssisted)),
    tier: certificateTier || (salesAssisted ? 'CERTIFIED' : ''),
    title: String(
      certificateRaw.title ||
        (certificateTier ? `${certificateTier.charAt(0)}${certificateTier.slice(1).toLowerCase()} Vendor on IndianTradeMart` : '')
    ).trim(),
    label: String(certificateRaw.label || certificateTier || '').trim(),
    printable: normalizeBool(certificateRaw.printable, true),
    shop_display: normalizeBool(certificateRaw.shop_display, true),
  };

  const seo = {
    enabled: normalizeBool(seoRaw.enabled, portfolio.premium || salesAssisted),
    portfolio_schema: normalizeBool(seoRaw.portfolio_schema, portfolio.premium || salesAssisted),
    sitemap: normalizeBool(seoRaw.sitemap, portfolio.premium || salesAssisted),
    custom_keywords: normalizeBool(seoRaw.custom_keywords, salesAssisted),
    url_aliases: normalizePositiveInt(seoRaw.url_aliases, salesAssisted ? 5 : 0),
    city_category_pages: normalizePositiveInt(seoRaw.city_category_pages, salesAssisted ? 50 : 0),
  };

  return {
    purchase: {
      channel: salesAssisted ? SALES_ASSISTED_CHANNEL : DIRECT_CHANNEL,
      sales_assisted: salesAssisted,
      public_purchase_enabled: publicPurchaseEnabled,
      cta_label: String(purchaseRaw.cta_label || (salesAssisted ? 'Talk to sales' : 'Buy online')).trim(),
    },
    badge: asPlanObject(features.badge),
    portfolio,
    certificate,
    seo,
    sitemap: {
      customizable: portfolio.sitemap_customization,
      url_boost: portfolio.sitemap_url_boost,
      seo_pages: seo.city_category_pages,
    },
  };
};

export const isSalesAssistedPlan = (plan = null) => getPlanEntitlements(plan).purchase.sales_assisted;

export const isDirectPurchasePlan = (plan = null) =>
  getPlanEntitlements(plan).purchase.public_purchase_enabled;

export const isPremiumPortfolioPlan = (plan = null) =>
  getPlanEntitlements(plan).portfolio.template === 'PREMIUM';

export const hasPlanPurchaseControls = (plan = null) => {
  const features = asPlanObject(plan?.features);
  return Object.keys(asPlanObject(features.purchase)).length > 0;
};

export const isVisibleCatalogPlan = (plan = null) => {
  const name = String(plan?.name || '').trim().toLowerCase();
  if (!name) return false;
  return hasPlanPurchaseControls(plan);
};

const baseFeatures = ({
  channel = DIRECT_CHANNEL,
  badge,
  listing,
  verification,
  leads,
  support,
  analytics,
  coverage,
  pricing,
  portfolio,
  certificate,
  seo,
}) =>
  normalizePlanFeatures({
    purchase: {
      channel,
      sales_assisted: channel === SALES_ASSISTED_CHANNEL,
      public_purchase_enabled: channel !== SALES_ASSISTED_CHANNEL,
      cta_label: channel === SALES_ASSISTED_CHANNEL ? 'Talk to sales' : 'Buy online',
    },
    badge,
    listing,
    verification,
    leads,
    support,
    analytics,
    coverage,
    pricing,
    portfolio,
    certificate,
    seo,
  });

export const VENDOR_PLAN_CATALOG = [
  {
    name: 'Trial',
    description: 'Free starter access for vendors to test marketplace listing and lead unlock workflow.',
    price: 0,
    daily_limit: 1,
    weekly_limit: 7,
    yearly_limit: 365,
    duration_days: 365,
    is_active: true,
    features: baseFeatures({
      badge: { label: 'Trial', variant: 'neutral' },
      listing: { ranking_label: 'Remaining all', highlight: false },
      leads: { rfq_access: true },
      support: { level: 'standard' },
      analytics: { enabled: false },
      coverage: { states_limit: 1, cities_limit: 10 },
      pricing: { currency: 'INR', original_price: 0, discount_percent: 0, discount_label: '' },
      portfolio: { enabled: true, template: 'STANDARD' },
      certificate: { enabled: false },
      seo: { enabled: false, sitemap: true },
    }),
  },
  {
    name: 'Startup',
    description: 'Direct purchase starter plan with basic search coverage and weekly lead capacity.',
    price: 15000,
    daily_limit: 1,
    weekly_limit: 15,
    yearly_limit: 780,
    duration_days: 365,
    is_active: true,
    features: baseFeatures({
      badge: { label: 'Startup', variant: 'slate' },
      listing: { ranking_label: 'All Startup Plan Member', highlight: true, featured: true, home_category_boost: true },
      leads: { priority_leads: true, rfq_access: true, direct_call_whatsapp: true },
      support: { level: 'priority', response_sla_hours: 24 },
      analytics: { enabled: true },
      coverage: { states_limit: 3, cities_limit: 30 },
      pricing: { currency: 'INR', original_price: 20000, discount_percent: 25, discount_label: '25% OFF' },
      portfolio: { enabled: true, template: 'STANDARD' },
      certificate: { enabled: false },
      seo: { enabled: true, sitemap: true, city_category_pages: 10 },
    }),
  },
  {
    name: 'Certified',
    description: 'Direct purchase verified plan with stronger trust signals and broader city coverage.',
    price: 22500,
    daily_limit: 2,
    weekly_limit: 20,
    yearly_limit: 1040,
    duration_days: 365,
    is_active: true,
    features: baseFeatures({
      badge: { label: 'Certified', variant: 'blue' },
      listing: { highlight: true, featured: true, category_top_ranking: true, profile_verified_tick: true, top_slots: 2 },
      verification: { kyc_required: true, trust_seal: true },
      leads: { priority_leads: true, early_access_leads: true, rfq_access: true, direct_call_whatsapp: true },
      support: { level: 'priority', response_sla_hours: 12 },
      analytics: { enabled: true, export_csv: true },
      coverage: { states_limit: 5, cities_limit: 40 },
      pricing: { currency: 'INR', original_price: 30000, discount_percent: 25, discount_label: '25% OFF' },
      portfolio: { enabled: true, template: 'STANDARD', custom_url: false },
      certificate: { enabled: false },
      seo: { enabled: true, sitemap: true, city_category_pages: 25 },
    }),
  },
  {
    name: 'Booster',
    description: 'Direct purchase growth plan for wider location coverage and better lead availability.',
    price: 30000,
    daily_limit: 2,
    weekly_limit: 30,
    yearly_limit: 1560,
    duration_days: 365,
    is_active: true,
    features: baseFeatures({
      badge: { label: 'Booster', variant: 'purple' },
      listing: { highlight: true, featured: true, category_top_ranking: true, profile_verified_tick: true, top_slots: 3 },
      verification: { kyc_required: true, trust_seal: true },
      leads: { priority_leads: true, early_access_leads: true, rfq_access: true, direct_call_whatsapp: true },
      support: { level: 'priority', response_sla_hours: 12 },
      analytics: { enabled: true, export_csv: true },
      coverage: { states_limit: 7, cities_limit: 50 },
      pricing: { currency: 'INR', original_price: 40000, discount_percent: 25, discount_label: '25% OFF' },
      portfolio: { enabled: true, template: 'STANDARD', custom_url: false },
      certificate: { enabled: false },
      seo: { enabled: true, sitemap: true, city_category_pages: 35 },
    }),
  },
  {
    name: 'Silver',
    description: 'Sales-assisted portfolio plan with Silver Vendor badge, printable certificate, and SEO-ready profile structure.',
    price: 52500,
    daily_limit: 4,
    weekly_limit: 70,
    yearly_limit: 3640,
    duration_days: 365,
    is_active: true,
    features: baseFeatures({
      channel: SALES_ASSISTED_CHANNEL,
      badge: { label: 'Silver Vendor', variant: 'silver' },
      listing: { highlight: true, featured: true, category_top_ranking: true, profile_verified_tick: true, top_slots: 4 },
      verification: { kyc_required: true, trust_seal: true },
      leads: { priority_leads: true, early_access_leads: true, rfq_access: true, direct_call_whatsapp: true },
      support: { level: 'sales-assisted', response_sla_hours: 8, account_manager: true },
      analytics: { enabled: true, export_csv: true, campaign_insights: true },
      coverage: { states_limit: 10, cities_limit: 70 },
      pricing: { currency: 'INR', original_price: 70000, discount_percent: 25, discount_label: '25% OFF' },
      portfolio: {
        enabled: true,
        template: 'PREMIUM',
        customizable: true,
        custom_url: true,
        custom_sections: true,
        sitemap_customization: true,
        sitemap_url_boost: 150,
        showcase_label: 'Silver portfolio',
      },
      certificate: {
        enabled: true,
        tier: 'SILVER',
        title: 'Silver Vendor on IndianTradeMart',
        printable: true,
        shop_display: true,
      },
      seo: { enabled: true, portfolio_schema: true, sitemap: true, custom_keywords: true, url_aliases: 3, city_category_pages: 75 },
    }),
  },
  {
    name: 'Gold',
    description: 'Sales-assisted premium SEO plan with Gold Vendor certificate, managed profile content, and extended sitemap reach.',
    price: 112500,
    daily_limit: 5,
    weekly_limit: 105,
    yearly_limit: 5460,
    duration_days: 365,
    is_active: true,
    features: baseFeatures({
      channel: SALES_ASSISTED_CHANNEL,
      badge: { label: 'Gold Vendor', variant: 'gold' },
      listing: { highlight: true, featured: true, homepage_featured: true, category_top_ranking: true, profile_verified_tick: true, top_slots: 8 },
      verification: { kyc_required: true, trust_seal: true },
      leads: { priority_leads: true, exclusive_leads: true, early_access_leads: true, rfq_access: true, direct_call_whatsapp: true },
      support: { level: 'managed', response_sla_hours: 4, account_manager: true },
      analytics: { enabled: true, export_csv: true, campaign_insights: true, competitor_insights: true },
      coverage: { states_limit: 15, cities_limit: 90 },
      pricing: { currency: 'INR', original_price: 150000, discount_percent: 25, discount_label: '25% OFF' },
      portfolio: {
        enabled: true,
        template: 'PREMIUM',
        customizable: true,
        custom_url: true,
        custom_sections: true,
        sitemap_customization: true,
        sitemap_url_boost: 300,
        showcase_label: 'Gold SEO portfolio',
      },
      certificate: {
        enabled: true,
        tier: 'GOLD',
        title: 'Gold Vendor on IndianTradeMart',
        printable: true,
        shop_display: true,
      },
      seo: { enabled: true, portfolio_schema: true, sitemap: true, custom_keywords: true, url_aliases: 8, city_category_pages: 200 },
    }),
  },
  {
    name: 'Diamond',
    description: 'Sales-assisted flagship plan for a custom showcase portfolio, Diamond certificate, managed SEO, and highest ranking.',
    price: 187500,
    daily_limit: 7,
    weekly_limit: 150,
    yearly_limit: 7800,
    duration_days: 365,
    is_active: true,
    features: baseFeatures({
      channel: SALES_ASSISTED_CHANNEL,
      badge: { label: 'Diamond Vendor', variant: 'diamond' },
      listing: { highlight: true, featured: true, homepage_featured: true, category_top_ranking: true, profile_verified_tick: true, top_slots: 15 },
      verification: { kyc_required: true, trust_seal: true },
      leads: { priority_leads: true, exclusive_leads: true, early_access_leads: true, rfq_access: true, direct_call_whatsapp: true },
      support: { level: 'white-glove', response_sla_hours: 2, account_manager: true },
      analytics: { enabled: true, export_csv: true, campaign_insights: true, competitor_insights: true },
      coverage: { states_limit: 20, cities_limit: 100 },
      pricing: { currency: 'INR', original_price: 250000, discount_percent: 25, discount_label: '25% OFF' },
      portfolio: {
        enabled: true,
        template: 'PREMIUM',
        customizable: true,
        custom_url: true,
        custom_sections: true,
        sitemap_customization: true,
        sitemap_url_boost: 600,
        showcase_label: 'Diamond showcase portfolio',
      },
      certificate: {
        enabled: true,
        tier: 'DIAMOND',
        title: 'Diamond Vendor on IndianTradeMart',
        printable: true,
        shop_display: true,
      },
      seo: { enabled: true, portfolio_schema: true, sitemap: true, custom_keywords: true, url_aliases: 15, city_category_pages: 500 },
    }),
  },
];
