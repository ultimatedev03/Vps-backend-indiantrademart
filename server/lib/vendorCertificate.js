import { jsPDF } from 'jspdf';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlanEntitlements } from './vendorPlanCatalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_PUBLIC_DIR = resolve(__dirname, '../../../frontend/public');
const imageCache = new Map();

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

const loadPublicPng = (fileName) => {
  if (imageCache.has(fileName)) return imageCache.get(fileName);
  try {
    const file = readFileSync(resolve(FRONTEND_PUBLIC_DIR, fileName));
    const dataUri = file?.length ? `data:image/png;base64,${file.toString('base64')}` : null;
    imageCache.set(fileName, dataUri);
    return dataUri;
  } catch {
    imageCache.set(fileName, null);
    return null;
  }
};

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
  if (token === 'DIAMOND') {
    return {
      primary: [0, 107, 130],
      accent: [32, 201, 210],
      pale: [231, 252, 255],
      paper: [247, 254, 255],
      metal: [185, 135, 68],
    };
  }
  if (token === 'GOLD') {
    return {
      primary: [137, 92, 8],
      accent: [218, 165, 32],
      pale: [255, 248, 226],
      paper: [255, 253, 244],
      metal: [181, 121, 20],
    };
  }
  if (token === 'SILVER') {
    return {
      primary: [71, 85, 105],
      accent: [148, 163, 184],
      pale: [248, 250, 252],
      paper: [255, 255, 255],
      metal: [100, 116, 139],
    };
  }
  return {
    primary: [0, 61, 130],
    accent: [0, 166, 153],
    pale: [239, 246, 255],
    paper: [255, 255, 255],
    metal: [183, 126, 48],
  };
};

const withOpacity = (pdf, opacity, draw) => {
  if (
    typeof pdf.saveGraphicsState === 'function' &&
    typeof pdf.restoreGraphicsState === 'function' &&
    typeof pdf.setGState === 'function' &&
    typeof pdf.GState === 'function'
  ) {
    pdf.saveGraphicsState();
    pdf.setGState(new pdf.GState({ opacity }));
    draw();
    pdf.restoreGraphicsState();
    return;
  }
  draw();
};

const fitFontSize = (pdf, text, maxWidth, startSize, minSize) => {
  let size = startSize;
  pdf.setFontSize(size);
  while (size > minSize && pdf.getTextWidth(text) > maxWidth) {
    size -= 1;
    pdf.setFontSize(size);
  }
  return size;
};

const drawCenteredLines = (pdf, lines, x, y, lineHeight, options = {}) => {
  lines.forEach((line, index) => {
    pdf.text(line, x, y + index * lineHeight, { align: 'center', ...options });
  });
};

const drawFallbackBrandLockup = (pdf, colors, x, y) => {
  pdf.setFillColor(...colors.metal);
  pdf.circle(x + 26, y + 26, 24, 'F');
  pdf.setDrawColor(255, 255, 255);
  pdf.setLineWidth(1);
  pdf.line(x + 6, y + 26, x + 46, y + 26);
  pdf.line(x + 26, y + 4, x + 26, y + 48);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(12);
  pdf.setTextColor(255, 255, 255);
  pdf.text('ITM', x + 26, y + 31, { align: 'center' });
  pdf.setFontSize(16);
  pdf.setTextColor(...colors.primary);
  pdf.text('IndianTradeMart', x + 60, y + 23);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.setTextColor(100, 116, 139);
  pdf.text('Connect & Grow', x + 60, y + 39);
};

export const generateVendorCertificatePDF = ({ vendor = {}, plan = {}, subscription = {} } = {}) => {
  const meta = buildVendorCertificateMeta({ vendor, plan, subscription });
  if (!meta) return null;

  const colors = tierColors(meta.tier);
  const brandLogo = loadPublicPng('itm-logo.png');
  const brandMark = loadPublicPng('itm-mark.png');
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 34;
  const innerMargin = 50;
  const paperX = 28;
  const paperY = 26;
  const paperW = pageWidth - 56;
  const paperH = pageHeight - 52;
  const centerX = pageWidth / 2;

  pdf.setFillColor(...colors.pale);
  pdf.rect(0, 0, pageWidth, pageHeight, 'F');

  pdf.setFillColor(255, 255, 255);
  pdf.roundedRect(paperX + 4, paperY + 5, paperW, paperH, 10, 10, 'F');
  pdf.setFillColor(...colors.paper);
  pdf.roundedRect(paperX, paperY, paperW, paperH, 10, 10, 'F');

  withOpacity(pdf, 0.07, () => {
    if (brandMark) {
      pdf.addImage(brandMark, 'PNG', centerX - 142, 158, 284, 284, undefined, 'FAST');
    }
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(52);
    pdf.setTextColor(...colors.primary);
    pdf.text('INDIANTRADEMART', centerX, 328, { align: 'center', angle: -24 });
  });

  pdf.setDrawColor(...colors.primary);
  pdf.setLineWidth(3.5);
  pdf.rect(margin, margin, pageWidth - margin * 2, pageHeight - margin * 2);
  pdf.setDrawColor(...colors.accent);
  pdf.setLineWidth(1.2);
  pdf.rect(innerMargin, innerMargin, pageWidth - innerMargin * 2, pageHeight - innerMargin * 2);

  pdf.setDrawColor(...colors.metal);
  pdf.setLineWidth(1);
  pdf.line(78, 70, 276, 70);
  pdf.line(pageWidth - 276, 70, pageWidth - 78, 70);
  pdf.line(78, pageHeight - 70, 276, pageHeight - 70);
  pdf.line(pageWidth - 276, pageHeight - 70, pageWidth - 78, pageHeight - 70);

  if (brandLogo) {
    pdf.addImage(brandLogo, 'PNG', 72, 72, 132, 68, undefined, 'FAST');
  } else if (brandMark) {
    pdf.addImage(brandMark, 'PNG', 78, 72, 56, 56, undefined, 'FAST');
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(16);
    pdf.setTextColor(...colors.primary);
    pdf.text('IndianTradeMart', 142, 98);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(100, 116, 139);
    pdf.text('Connect & Grow', 142, 114);
  } else {
    drawFallbackBrandLockup(pdf, colors, 76, 76);
  }

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(18);
  pdf.setTextColor(...colors.primary);
  pdf.text('INDIAN TRADE MART', centerX, 92, { align: 'center' });

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8.5);
  pdf.setTextColor(75, 85, 99);
  pdf.text('CONNECT & GROW', centerX, 109, { align: 'center' });

  pdf.setFillColor(...colors.primary);
  pdf.roundedRect(pageWidth - 190, 74, 112, 30, 15, 15, 'F');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9.5);
  pdf.setTextColor(255, 255, 255);
  pdf.text(`${meta.tier || 'CERTIFIED'} VERIFIED`, pageWidth - 134, 93, { align: 'center' });

  pdf.setDrawColor(...colors.metal);
  pdf.setLineWidth(1);
  pdf.line(centerX - 170, 128, centerX - 34, 128);
  pdf.line(centerX + 34, 128, centerX + 170, 128);
  pdf.setFillColor(...colors.metal);
  pdf.circle(centerX, 128, 4, 'F');

  pdf.setFont('helvetica', 'bold');
  fitFontSize(pdf, meta.title.toUpperCase(), pageWidth - 148, 31, 23);
  pdf.setTextColor(15, 23, 42);
  const titleLines = pdf.splitTextToSize(meta.title.toUpperCase(), pageWidth - 148);
  drawCenteredLines(pdf, titleLines.slice(0, 2), centerX, 174, 33);
  const titleBottomY = 174 + (Math.min(titleLines.length, 2) - 1) * 33;

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(14);
  pdf.setTextColor(71, 85, 105);
  pdf.text('This certificate is proudly presented to', centerX, titleBottomY + 45, { align: 'center' });

  pdf.setFont('helvetica', 'bold');
  fitFontSize(pdf, meta.vendor_name, pageWidth - 190, 32, 22);
  pdf.setTextColor(...colors.primary);
  pdf.text(meta.vendor_name, centerX, titleBottomY + 93, { align: 'center', maxWidth: pageWidth - 170 });

  pdf.setDrawColor(...colors.accent);
  pdf.setLineWidth(1.2);
  pdf.line(centerX - 82, titleBottomY + 111, centerX + 82, titleBottomY + 111);

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(13);
  pdf.setTextColor(51, 65, 85);
  const body = `for maintaining an active ${meta.plan_name} membership and verified business presence on IndianTradeMart.`;
  pdf.text(body, centerX, titleBottomY + 146, { align: 'center', maxWidth: pageWidth - 178 });

  pdf.setFillColor(255, 255, 255);
  pdf.roundedRect(100, 352, pageWidth - 200, 92, 8, 8, 'F');
  pdf.setDrawColor(226, 232, 240);
  pdf.roundedRect(100, 352, pageWidth - 200, 92, 8, 8);
  pdf.setDrawColor(...colors.accent);
  pdf.setLineWidth(2);
  pdf.line(118, 352, pageWidth - 118, 352);

  const infoY = 382;
  const cols = [
    ['Certificate No.', meta.certificate_number],
    ['Vendor ID', meta.vendor_id],
    ['Issued On', meta.issued_on || '-'],
    ['Valid Until', meta.valid_until || 'Active plan'],
  ];
  const colWidth = (pageWidth - 240) / cols.length;
  cols.forEach(([label, value], index) => {
    const x = 122 + index * colWidth;
    if (index > 0) {
      pdf.setDrawColor(226, 232, 240);
      pdf.setLineWidth(0.8);
      pdf.line(x - 20, 374, x - 20, 426);
    }
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(100, 116, 139);
    pdf.text(label, x, infoY);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.setTextColor(15, 23, 42);
    pdf.text(String(value || '-'), x, infoY + 24, { maxWidth: colWidth - 24 });
  });

  const sealX = pageWidth - 172;
  const sealY = pageHeight - 116;
  pdf.setFillColor(255, 255, 255);
  pdf.circle(sealX, sealY, 35, 'F');
  pdf.setDrawColor(...colors.metal);
  pdf.setLineWidth(2);
  pdf.circle(sealX, sealY, 35);
  pdf.setDrawColor(...colors.accent);
  pdf.setLineWidth(1);
  pdf.circle(sealX, sealY, 26);
  if (brandMark) {
    withOpacity(pdf, 0.78, () => {
      pdf.addImage(brandMark, 'PNG', sealX - 17, sealY - 17, 34, 34, undefined, 'FAST');
    });
  }
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(6.8);
  pdf.setTextColor(...colors.primary);
  pdf.text('VERIFIED', sealX, sealY + 28, { align: 'center' });

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10);
  pdf.setTextColor(71, 85, 105);
  pdf.setDrawColor(...colors.primary);
  pdf.setLineWidth(1.6);
  pdf.line(118, pageHeight - 116, 300, pageHeight - 116);
  pdf.text('Authorized by IndianTradeMart', 118, pageHeight - 94);
  pdf.setFontSize(8);
  pdf.setTextColor(100, 116, 139);
  pdf.text('Digital membership certificate', 118, pageHeight - 78);

  if (meta.profile_url) {
    pdf.setFontSize(9);
    pdf.setTextColor(100, 116, 139);
    pdf.text(meta.profile_url, pageWidth - 118, pageHeight - 78, { align: 'right', maxWidth: 292 });
  }

  return Buffer.from(pdf.output('arraybuffer'));
};
