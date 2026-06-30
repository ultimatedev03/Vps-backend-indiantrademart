import { jsPDF } from 'jspdf';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VENDOR_PLAN_CATALOG, getPlanEntitlements } from '../lib/vendorPlanCatalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(__dirname, '../..');
const WORKSPACE_ROOT = resolve(BACKEND_ROOT, '..');
const OUTPUTS = [
  resolve(BACKEND_ROOT, 'docs/IndianTradeMart-Plan-Sales-Guide.pdf'),
  resolve(WORKSPACE_ROOT, 'frontend/public/docs/IndianTradeMart-Plan-Sales-Guide.pdf'),
];

const COLORS = {
  ink: [10, 23, 45],
  blue: [0, 61, 130],
  teal: [0, 145, 132],
  gold: [183, 126, 48],
  coral: [213, 79, 61],
  paper: [247, 249, 252],
  line: [220, 227, 236],
  muted: [91, 105, 125],
  white: [255, 255, 255],
};

const PLAN_ACCENTS = {
  Trial: [100, 116, 139],
  Startup: [37, 99, 235],
  Certified: [0, 145, 132],
  Booster: [124, 58, 237],
  Silver: [100, 116, 139],
  Gold: [183, 126, 48],
  Diamond: [0, 107, 130],
};

const SALES_GUIDANCE = {
  Trial: {
    bestFor: 'A new vendor who wants to understand listing, search visibility, and lead unlocking before paying.',
    example: 'A Patna saree seller lists products, selects Bihar and nearby cities, and tests one included lead unlock per day.',
    pitch: 'Start free, complete the profile, add real products, and learn the buyer workflow before choosing a growth plan.',
    upgrade: 'Move to Startup when the vendor needs more cities, stronger listing placement, or more weekly leads.',
  },
  Startup: {
    bestFor: 'Small local suppliers beginning structured online selling across a few nearby markets.',
    example: 'A footwear wholesaler targets Uttar Pradesh, Delhi, and Haryana with 30 chosen cities and up to 15 included unlocks per week.',
    pitch: 'A practical first paid plan for regional visibility, direct buyer contact, and a predictable lead allowance.',
    upgrade: 'Move to Certified for stronger trust signals, KYC-backed verification, and wider coverage.',
  },
  Certified: {
    bestFor: 'Established vendors who need buyer trust, verification, and stronger category visibility.',
    example: 'A painting contractor completes KYC, displays the Certified badge and certificate, and targets 40 cities across five states.',
    pitch: 'Best for businesses that need buyers to see a verified identity before they call, enquire, or shortlist.',
    upgrade: 'Move to Booster when lead demand or territory coverage becomes the primary growth constraint.',
  },
  Booster: {
    bestFor: 'Regional vendors ready for wider territory, better placement, and a larger weekly lead pool.',
    example: 'An industrial tools supplier serves seven states, selects 50 high-value cities, and can unlock up to 30 included leads each week.',
    pitch: 'Choose Booster when the vendor already converts online leads and wants more reach without a managed portfolio engagement.',
    upgrade: 'Move to Silver when a custom portfolio, certificate-led marketing, and sales-assisted setup become important.',
  },
  Silver: {
    bestFor: 'Growth-stage vendors who want a premium public portfolio and guided digital positioning.',
    example: 'A textile manufacturer receives a Silver Vendor certificate, custom profile URL, premium sections, and SEO coverage across 70 cities.',
    pitch: 'Silver turns a marketplace profile into a presentable business portfolio that sales teams can share with buyers.',
    upgrade: 'Move to Gold for managed SEO, homepage exposure, deeper analytics, and a dedicated account-led experience.',
  },
  Gold: {
    bestFor: 'Multi-state businesses that want managed visibility, stronger ranking, and broader SEO reach.',
    example: 'A machinery company targets 15 states and 90 cities while using a Gold certificate, managed profile content, and extended sitemap reach.',
    pitch: 'Gold combines visibility, credibility, and active account support for vendors with an established sales operation.',
    upgrade: 'Move to Diamond when the brand needs the highest placement, widest reach, and a flagship showcase portfolio.',
  },
  Diamond: {
    bestFor: 'Large vendors and premium brands seeking maximum marketplace presence and white-glove support.',
    example: 'A national engineering company receives a Diamond showcase portfolio, 20-state coverage, 100 selected cities, and priority placement.',
    pitch: 'Diamond is the flagship plan for a vendor whose profile must work like a high-trust digital sales asset.',
    upgrade: 'Retain or renew when the account requires the highest ranking, managed SEO, and portfolio customization.',
  },
};

const money = (value) => `Rs. ${Number(value || 0).toLocaleString('en-IN')}`;
const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

const registerFonts = (pdf) => {
  const fontDir = resolve(BACKEND_ROOT, 'server/assets/fonts');
  const regular = readFileSync(resolve(fontDir, 'BricolageGrotesque-Regular.ttf')).toString('base64');
  const bold = readFileSync(resolve(fontDir, 'BricolageGrotesque-Bold.ttf')).toString('base64');
  pdf.addFileToVFS('Bricolage-Regular.ttf', regular);
  pdf.addFileToVFS('Bricolage-Bold.ttf', bold);
  pdf.addFont('Bricolage-Regular.ttf', 'Bricolage', 'normal');
  pdf.addFont('Bricolage-Bold.ttf', 'Bricolage', 'bold');
};

const drawBrand = (pdf, x = 40, y = 32) => {
  const logoPath = resolve(WORKSPACE_ROOT, 'frontend/public/itm-logo.png');
  try {
    const logo = readFileSync(logoPath).toString('base64');
    pdf.addImage(`data:image/png;base64,${logo}`, 'PNG', x, y, 92, 45, undefined, 'FAST');
  } catch {
    pdf.setFont('Bricolage', 'bold');
    pdf.setFontSize(16);
    pdf.setTextColor(...COLORS.blue);
    pdf.text('IndianTradeMart', x, y + 24);
  }
};

const addPageFrame = (pdf, pageNumber, section) => {
  const width = pdf.internal.pageSize.getWidth();
  const height = pdf.internal.pageSize.getHeight();
  pdf.setFillColor(...COLORS.paper);
  pdf.rect(0, 0, width, height, 'F');
  pdf.setFillColor(...COLORS.white);
  pdf.roundedRect(24, 22, width - 48, height - 44, 10, 10, 'F');
  pdf.setDrawColor(...COLORS.line);
  pdf.roundedRect(24, 22, width - 48, height - 44, 10, 10);
  drawBrand(pdf);
  pdf.setFont('Bricolage', 'bold');
  pdf.setFontSize(8);
  pdf.setTextColor(...COLORS.muted);
  pdf.text(String(section || '').toUpperCase(), width - 42, 48, { align: 'right' });
  pdf.setDrawColor(...COLORS.line);
  pdf.line(40, 84, width - 40, 84);
  pdf.setFont('Bricolage', 'normal');
  pdf.setFontSize(8);
  pdf.text(`INDIANTRADEMART SALES PLAYBOOK  /  ${String(pageNumber).padStart(2, '0')}`, 40, height - 38);
  pdf.text('Internal sales enablement', width - 40, height - 38, { align: 'right' });
};

const wrappedText = (pdf, text, x, y, maxWidth, options = {}) => {
  const lines = pdf.splitTextToSize(String(text || ''), maxWidth);
  const lineHeight = options.lineHeight || 15;
  pdf.text(lines, x, y, { lineHeightFactor: lineHeight / Math.max(1, pdf.getFontSize()), ...options });
  return y + lines.length * lineHeight;
};

const statCard = (pdf, x, y, width, label, value, accent = COLORS.blue) => {
  pdf.setFillColor(250, 252, 255);
  pdf.setDrawColor(...COLORS.line);
  pdf.roundedRect(x, y, width, 58, 6, 6, 'FD');
  pdf.setFillColor(...accent);
  pdf.roundedRect(x + 10, y + 10, 4, 38, 2, 2, 'F');
  pdf.setFont('Bricolage', 'normal');
  pdf.setFontSize(8);
  pdf.setTextColor(...COLORS.muted);
  pdf.text(label.toUpperCase(), x + 24, y + 22);
  pdf.setFont('Bricolage', 'bold');
  pdf.setFontSize(17);
  pdf.setTextColor(...COLORS.ink);
  pdf.text(String(value), x + 24, y + 43);
};

const bulletList = (pdf, items, x, y, maxWidth, accent) => {
  let cursor = y;
  items.slice(0, 7).forEach((item) => {
    pdf.setFillColor(...accent);
    pdf.circle(x + 3, cursor - 3, 2.4, 'F');
    pdf.setFont('Bricolage', 'normal');
    pdf.setFontSize(10);
    pdf.setTextColor(...COLORS.ink);
    cursor = wrappedText(pdf, item, x + 13, cursor, maxWidth - 13, { lineHeight: 13 }) + 5;
  });
  return cursor;
};

const planBenefits = (plan) => {
  const features = asObject(plan.features);
  const listing = asObject(features.listing);
  const leads = asObject(features.leads);
  const support = asObject(features.support);
  const analytics = asObject(features.analytics);
  const portfolio = asObject(features.portfolio);
  const certificate = asObject(features.certificate);
  const seo = asObject(features.seo);
  const benefits = [];
  if (listing.highlight) benefits.push('Highlighted listing in eligible search areas');
  if (listing.featured) benefits.push('Featured listing and improved category placement');
  if (listing.category_top_ranking) benefits.push(`Category ranking with ${Number(listing.top_slots || 0) || 'priority'} placement slots`);
  if (listing.profile_verified_tick) benefits.push('Verified profile tick after required KYC approval');
  if (leads.early_access_leads) benefits.push('Early access to relevant marketplace leads');
  if (leads.priority_leads) benefits.push('Priority lead access plus RFQ and direct contact tools');
  if (portfolio.customizable) benefits.push('Customizable premium portfolio with custom profile URL');
  if (certificate.enabled) benefits.push(`${certificate.title || 'Printable vendor certificate'} for shop and proposals`);
  if (seo.enabled) benefits.push(`SEO-ready profile with ${Number(seo.city_category_pages || 0)} city/category pages`);
  if (analytics.enabled) benefits.push(analytics.export_csv ? 'Analytics dashboard with CSV export' : 'Vendor analytics dashboard');
  if (support.account_manager) benefits.push(`Account manager and ${Number(support.response_sla_hours || 0)}-hour support SLA`);
  if (!benefits.length) benefits.push('Standard business profile and marketplace listing access');
  return benefits;
};

const drawCover = (pdf) => {
  const width = pdf.internal.pageSize.getWidth();
  const height = pdf.internal.pageSize.getHeight();
  pdf.setFillColor(...COLORS.ink);
  pdf.rect(0, 0, width, height, 'F');
  pdf.setFillColor(...COLORS.teal);
  pdf.rect(0, 0, 18, height, 'F');
  drawBrand(pdf, 52, 45);
  pdf.setFont('Bricolage', 'bold');
  pdf.setFontSize(46);
  pdf.setTextColor(...COLORS.white);
  pdf.text('PLAN', 52, 210);
  pdf.text('SALES GUIDE', 52, 262);
  pdf.setFillColor(...COLORS.gold);
  pdf.rect(52, 287, 168, 5, 'F');
  pdf.setFont('Bricolage', 'normal');
  pdf.setFontSize(15);
  pdf.setTextColor(205, 216, 229);
  wrappedText(pdf, 'A clear reference for matching each vendor to the right IndianTradeMart plan.', 52, 332, 360, { lineHeight: 23 });
  const planNames = VENDOR_PLAN_CATALOG.map((plan) => plan.name.toUpperCase());
  planNames.forEach((name, index) => {
    const row = index % 4;
    const col = Math.floor(index / 4);
    const x = 54 + col * 235;
    const y = 506 + row * 43;
    pdf.setDrawColor(60, 79, 105);
    pdf.roundedRect(x, y, 210, 30, 15, 15);
    pdf.setFont('Bricolage', 'bold');
    pdf.setFontSize(9);
    pdf.setTextColor(226, 232, 240);
    pdf.text(name, x + 16, y + 19);
  });
  pdf.setFont('Bricolage', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(148, 163, 184);
  pdf.text('VERSION 2026.06  /  SALES ENABLEMENT', 52, height - 48);
};

const drawHowPlansWork = (pdf, pageNumber) => {
  addPageFrame(pdf, pageNumber, 'How plans work');
  pdf.setFont('Bricolage', 'bold');
  pdf.setFontSize(29);
  pdf.setTextColor(...COLORS.ink);
  pdf.text('Five numbers explain the plan', 40, 126);
  pdf.setFont('Bricolage', 'normal');
  pdf.setFontSize(11);
  pdf.setTextColor(...COLORS.muted);
  pdf.text('Use these definitions consistently with every client.', 40, 148);

  const definitions = [
    ['Daily leads', 'Maximum included buyer leads the vendor can unlock in one day.'],
    ['Weekly leads', 'Maximum included unlocks available in the week; daily usage also counts toward this total.'],
    ['Yearly leads', 'Plan-level annual capacity shown for commercial planning and quota reporting.'],
    ['States', 'Maximum states the vendor can choose for product visibility and relevant search matching.'],
    ['Cities', 'Maximum selected cities across those states where the vendor products can appear for location searches.'],
  ];
  definitions.forEach(([label, body], index) => {
    const y = 184 + index * 92;
    pdf.setFillColor(index % 2 ? 248 : 244, 248, 251);
    pdf.setDrawColor(...COLORS.line);
    pdf.roundedRect(40, y, 515, 72, 7, 7, 'FD');
    pdf.setFillColor(...(index < 3 ? COLORS.blue : COLORS.teal));
    pdf.circle(66, y + 36, 14, 'F');
    pdf.setFont('Bricolage', 'bold');
    pdf.setFontSize(10);
    pdf.setTextColor(...COLORS.white);
    pdf.text(String(index + 1), 66, y + 40, { align: 'center' });
    pdf.setFontSize(13);
    pdf.setTextColor(...COLORS.ink);
    pdf.text(label, 92, y + 25);
    pdf.setFont('Bricolage', 'normal');
    pdf.setFontSize(10);
    pdf.setTextColor(...COLORS.muted);
    wrappedText(pdf, body, 92, y + 45, 435, { lineHeight: 13 });
  });
};

const drawMonthlyPolicy = (pdf, pageNumber) => {
  addPageFrame(pdf, pageNumber, 'Monthly trial policy');
  pdf.setFont('Bricolage', 'bold');
  pdf.setFontSize(30);
  pdf.setTextColor(...COLORS.ink);
  pdf.text('One monthly trial. Shared once.', 40, 126);
  pdf.setFillColor(238, 250, 247);
  pdf.setDrawColor(153, 226, 210);
  pdf.roundedRect(40, 166, 515, 142, 9, 9, 'FD');
  pdf.setFont('Bricolage', 'bold');
  pdf.setFontSize(20);
  pdf.setTextColor(...COLORS.teal);
  pdf.text('STARTUP  +  CERTIFIED  +  BOOSTER', 62, 207);
  pdf.setFont('Bricolage', 'normal');
  pdf.setFontSize(12);
  pdf.setTextColor(...COLORS.ink);
  wrappedText(pdf, 'A vendor may activate one 30-day monthly subscription from this group in their lifetime. It is one shared opportunity, not one month on every plan.', 62, 240, 468, { lineHeight: 18 });

  const rules = [
    'After any monthly activation, every future purchase, upgrade, or switch uses yearly billing.',
    'Trial plan does not consume the one-time monthly opportunity.',
    'A coupon-covered monthly activation still counts as the monthly trial.',
    'Failed or cancelled checkout does not count; an activated monthly subscription does.',
    'Silver, Gold, and Diamond remain yearly, sales-assisted plans.',
  ];
  pdf.setFont('Bricolage', 'bold');
  pdf.setFontSize(13);
  pdf.setTextColor(...COLORS.ink);
  pdf.text('Sales rule', 40, 352);
  bulletList(pdf, rules, 44, 384, 505, COLORS.coral);

  pdf.setFillColor(255, 248, 235);
  pdf.setDrawColor(241, 205, 137);
  pdf.roundedRect(40, 610, 515, 96, 8, 8, 'FD');
  pdf.setFont('Bricolage', 'bold');
  pdf.setFontSize(11);
  pdf.setTextColor(145, 89, 14);
  pdf.text('EXAMPLE', 60, 638);
  pdf.setFont('Bricolage', 'normal');
  pdf.setFontSize(11);
  pdf.setTextColor(...COLORS.ink);
  wrappedText(pdf, 'If a vendor first buys Startup monthly, they cannot later buy Certified monthly. Their next Certified, Booster, or Startup purchase must be yearly.', 60, 662, 472, { lineHeight: 16 });
};

const drawPlanPage = (pdf, plan, pageNumber) => {
  addPageFrame(pdf, pageNumber, `${plan.name} plan`);
  const accent = PLAN_ACCENTS[plan.name] || COLORS.blue;
  const features = asObject(plan.features);
  const coverage = asObject(features.coverage);
  const pricing = asObject(features.pricing);
  const entitlement = getPlanEntitlements(plan);
  const guidance = SALES_GUIDANCE[plan.name];
  const monthly = pricing.monthly_enabled
    ? ` / one-time monthly ${money(pricing.monthly_price)}`
    : '';

  pdf.setFillColor(...accent);
  pdf.roundedRect(40, 108, 515, 105, 9, 9, 'F');
  pdf.setFont('Bricolage', 'bold');
  pdf.setFontSize(30);
  pdf.setTextColor(...COLORS.white);
  pdf.text(plan.name, 60, 150);
  pdf.setFontSize(20);
  pdf.text(`${money(plan.price)} / year`, 60, 181);
  pdf.setFont('Bricolage', 'normal');
  pdf.setFontSize(9);
  pdf.text(monthly || (entitlement.purchase.sales_assisted ? ' / sales-assisted activation' : ' / direct purchase'), 535, 181, { align: 'right' });

  const stats = [
    ['Daily leads', plan.daily_limit],
    ['Weekly leads', plan.weekly_limit],
    ['States', coverage.states_limit || 0],
    ['Cities', coverage.cities_limit || 0],
  ];
  stats.forEach(([label, value], index) => statCard(pdf, 40 + index * 131, 232, 121, label, value, accent));

  pdf.setFont('Bricolage', 'bold');
  pdf.setFontSize(13);
  pdf.setTextColor(...COLORS.ink);
  pdf.text('Best fit', 40, 332);
  pdf.setFont('Bricolage', 'normal');
  pdf.setFontSize(10.5);
  pdf.setTextColor(...COLORS.muted);
  wrappedText(pdf, guidance.bestFor, 40, 354, 240, { lineHeight: 15 });

  pdf.setFont('Bricolage', 'bold');
  pdf.setFontSize(13);
  pdf.setTextColor(...COLORS.ink);
  pdf.text('What the client gets', 306, 332);
  bulletList(pdf, planBenefits(plan), 308, 354, 238, accent);

  pdf.setFillColor(247, 249, 252);
  pdf.setDrawColor(...COLORS.line);
  pdf.roundedRect(40, 515, 515, 86, 8, 8, 'FD');
  pdf.setFont('Bricolage', 'bold');
  pdf.setFontSize(10);
  pdf.setTextColor(...accent);
  pdf.text('CLIENT EXAMPLE', 58, 541);
  pdf.setFont('Bricolage', 'normal');
  pdf.setFontSize(10.5);
  pdf.setTextColor(...COLORS.ink);
  wrappedText(pdf, guidance.example, 58, 564, 478, { lineHeight: 15 });

  pdf.setFillColor(240, 248, 255);
  pdf.setDrawColor(181, 215, 247);
  pdf.roundedRect(40, 620, 515, 78, 8, 8, 'FD');
  pdf.setFont('Bricolage', 'bold');
  pdf.setFontSize(10);
  pdf.setTextColor(...COLORS.blue);
  pdf.text('SAY THIS', 58, 646);
  pdf.setFont('Bricolage', 'normal');
  pdf.setFontSize(10.5);
  pdf.setTextColor(...COLORS.ink);
  wrappedText(pdf, `"${guidance.pitch}"`, 58, 669, 478, { lineHeight: 15 });

  pdf.setFont('Bricolage', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor(...COLORS.coral);
  pdf.text('UPGRADE SIGNAL', 40, 735);
  pdf.setFont('Bricolage', 'normal');
  pdf.setTextColor(...COLORS.muted);
  wrappedText(pdf, guidance.upgrade, 135, 735, 420, { lineHeight: 13 });
};

const drawComparison = (pdf, pageNumber) => {
  addPageFrame(pdf, pageNumber, 'Quick comparison');
  pdf.setFont('Bricolage', 'bold');
  pdf.setFontSize(29);
  pdf.setTextColor(...COLORS.ink);
  pdf.text('Plan desk reference', 40, 126);
  const headers = ['Plan', 'Price / year', 'D / W', 'States', 'Cities', 'Route'];
  const widths = [88, 102, 70, 60, 60, 115];
  let x = 40;
  pdf.setFillColor(...COLORS.ink);
  pdf.roundedRect(40, 158, 515, 35, 6, 6, 'F');
  headers.forEach((header, index) => {
    pdf.setFont('Bricolage', 'bold');
    pdf.setFontSize(8);
    pdf.setTextColor(...COLORS.white);
    pdf.text(header.toUpperCase(), x + 8, 180);
    x += widths[index];
  });

  VENDOR_PLAN_CATALOG.forEach((plan, index) => {
    const y = 202 + index * 62;
    const features = asObject(plan.features);
    const coverage = asObject(features.coverage);
    const entitlement = getPlanEntitlements(plan);
    pdf.setFillColor(index % 2 ? 249 : 244, 248, 251);
    pdf.roundedRect(40, y, 515, 52, 5, 5, 'F');
    const values = [
      plan.name,
      money(plan.price),
      `${plan.daily_limit} / ${plan.weekly_limit}`,
      coverage.states_limit || 0,
      coverage.cities_limit || 0,
      entitlement.purchase.sales_assisted ? 'Sales assisted' : plan.price > 0 ? 'Direct online' : 'Free',
    ];
    x = 40;
    values.forEach((value, col) => {
      pdf.setFont('Bricolage', col === 0 ? 'bold' : 'normal');
      pdf.setFontSize(col === 0 ? 10 : 9);
      pdf.setTextColor(...(col === 0 ? PLAN_ACCENTS[plan.name] : COLORS.ink));
      pdf.text(String(value), x + 8, y + 31, { maxWidth: widths[col] - 12 });
      x += widths[col];
    });
  });

  pdf.setFillColor(255, 248, 235);
  pdf.setDrawColor(241, 205, 137);
  pdf.roundedRect(40, 658, 515, 78, 8, 8, 'FD');
  pdf.setFont('Bricolage', 'bold');
  pdf.setFontSize(10);
  pdf.setTextColor(145, 89, 14);
  pdf.text('SALES CHECK', 58, 685);
  pdf.setFont('Bricolage', 'normal');
  pdf.setFontSize(10);
  pdf.setTextColor(...COLORS.ink);
  wrappedText(pdf, 'Ask three questions first: Where do you sell? How many buyer leads can you handle? Do you need only marketplace visibility, or a shareable premium portfolio?', 58, 708, 474, { lineHeight: 14 });
};

const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4', compress: true });
registerFonts(pdf);
drawCover(pdf);

let pageNumber = 2;
pdf.addPage();
drawHowPlansWork(pdf, pageNumber++);
pdf.addPage();
drawMonthlyPolicy(pdf, pageNumber++);
VENDOR_PLAN_CATALOG.forEach((plan) => {
  pdf.addPage();
  drawPlanPage(pdf, plan, pageNumber++);
});
pdf.addPage();
drawComparison(pdf, pageNumber);

const buffer = Buffer.from(pdf.output('arraybuffer'));
OUTPUTS.forEach((outputPath) => {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, buffer);
  console.log(`Plan sales guide written: ${outputPath}`);
});
