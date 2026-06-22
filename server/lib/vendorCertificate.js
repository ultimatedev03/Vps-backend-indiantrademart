import { jsPDF } from 'jspdf';
import { getPlanEntitlements } from './vendorPlanCatalog.js';

const formatDate = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
};

const safeText = (value, fallback = '') => String(value || '').replace(/\s+/g, ' ').trim() || fallback;

const titleCaseTier = (value = '') => {
  const token = String(value || '').trim().toUpperCase();
  if (!token) return 'Certified';
  return token.charAt(0) + token.slice(1).toLowerCase();
};

const normalizeSlug = (value = '') =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);

export const buildVendorCertificateMeta = ({ vendor = {}, plan = {}, subscription = {} } = {}) => {
  const entitlements = getPlanEntitlements(plan);
  const cert = entitlements.certificate || {};
  if (!cert.enabled) return null;

  const tier = String(cert.tier || 'CERTIFIED').trim().toUpperCase();
  const vendorCode = safeText(vendor.vendor_id || vendor.id, 'VENDOR');
  const issuedYear = new Date(subscription?.start_date || Date.now()).getFullYear();
  const certificateNumber = `ITM-${tier}-${String(vendorCode).replace(/[^A-Za-z0-9]/g, '').slice(0, 12).toUpperCase()}-${issuedYear}`;
  const slug = normalizeSlug(vendor.slug || vendor.company_name || vendor.vendor_id || vendor.id);

  return {
    certificate_number: certificateNumber,
    tier,
    title: safeText(cert.title, `${titleCaseTier(tier)} Vendor on IndianTradeMart`),
    vendor_name: safeText(vendor.company_name || vendor.owner_name, 'IndianTradeMart Vendor'),
    vendor_id: vendorCode,
    plan_name: safeText(plan.name, 'Vendor Plan'),
    issued_on: formatDate(subscription?.start_date || new Date()),
    valid_until: formatDate(subscription?.end_date),
    profile_url: slug ? `https://indiantrademart.com/directory/vendor/${encodeURIComponent(slug)}` : '',
    printable: cert.printable !== false,
    shop_display: cert.shop_display !== false,
  };
};

const tierColors = (tier = '') => {
  const token = String(tier || '').toUpperCase();
  if (token === 'DIAMOND') return { primary: [0, 123, 150], accent: [32, 201, 210], pale: [229, 252, 255] };
  if (token === 'GOLD') return { primary: [137, 92, 8], accent: [218, 165, 32], pale: [255, 248, 226] };
  if (token === 'SILVER') return { primary: [71, 85, 105], accent: [148, 163, 184], pale: [248, 250, 252] };
  return { primary: [0, 61, 130], accent: [0, 166, 153], pale: [239, 246, 255] };
};

export const generateVendorCertificatePDF = ({ vendor = {}, plan = {}, subscription = {} } = {}) => {
  const meta = buildVendorCertificateMeta({ vendor, plan, subscription });
  if (!meta) return null;

  const colors = tierColors(meta.tier);
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();

  pdf.setFillColor(...colors.pale);
  pdf.rect(0, 0, pageWidth, pageHeight, 'F');

  pdf.setDrawColor(...colors.primary);
  pdf.setLineWidth(4);
  pdf.rect(32, 32, pageWidth - 64, pageHeight - 64);
  pdf.setDrawColor(...colors.accent);
  pdf.setLineWidth(1.5);
  pdf.rect(46, 46, pageWidth - 92, pageHeight - 92);

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(24);
  pdf.setTextColor(...colors.primary);
  pdf.text('INDIAN TRADE MART', pageWidth / 2, 92, { align: 'center' });

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10);
  pdf.setTextColor(75, 85, 99);
  pdf.text('CONNECT & GROW', pageWidth / 2, 112, { align: 'center' });

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(34);
  pdf.setTextColor(15, 23, 42);
  pdf.text(meta.title.toUpperCase(), pageWidth / 2, 170, { align: 'center' });

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(14);
  pdf.setTextColor(71, 85, 105);
  pdf.text('This certificate is proudly presented to', pageWidth / 2, 214, { align: 'center' });

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(32);
  pdf.setTextColor(...colors.primary);
  pdf.text(meta.vendor_name, pageWidth / 2, 262, { align: 'center', maxWidth: pageWidth - 150 });

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(13);
  pdf.setTextColor(51, 65, 85);
  const body = `for maintaining an active ${meta.plan_name} membership and verified business presence on IndianTradeMart.`;
  pdf.text(body, pageWidth / 2, 306, { align: 'center', maxWidth: pageWidth - 180 });

  pdf.setFillColor(255, 255, 255);
  pdf.roundedRect(110, 352, pageWidth - 220, 86, 10, 10, 'F');
  pdf.setDrawColor(226, 232, 240);
  pdf.roundedRect(110, 352, pageWidth - 220, 86, 10, 10);

  const infoY = 382;
  const cols = [
    ['Certificate No.', meta.certificate_number],
    ['Vendor ID', meta.vendor_id],
    ['Issued On', meta.issued_on || '-'],
    ['Valid Until', meta.valid_until || 'Active plan'],
  ];
  const colWidth = (pageWidth - 260) / cols.length;
  cols.forEach(([label, value], index) => {
    const x = 130 + index * colWidth;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(100, 116, 139);
    pdf.text(label, x, infoY);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.setTextColor(15, 23, 42);
    pdf.text(String(value || '-'), x, infoY + 22, { maxWidth: colWidth - 16 });
  });

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10);
  pdf.setTextColor(71, 85, 105);
  pdf.text('Authorized by IndianTradeMart', 120, pageHeight - 92);
  pdf.setDrawColor(...colors.primary);
  pdf.line(120, pageHeight - 112, 292, pageHeight - 112);

  if (meta.profile_url) {
    pdf.setFontSize(9);
    pdf.setTextColor(100, 116, 139);
    pdf.text(meta.profile_url, pageWidth - 120, pageHeight - 92, { align: 'right', maxWidth: 260 });
  }

  return Buffer.from(pdf.output('arraybuffer'));
};

