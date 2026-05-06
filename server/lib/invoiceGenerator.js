import { jsPDF } from 'jspdf';
import crypto from 'crypto';

/**
 * Generate invoice number in format INV-YYYY-MM-XXXXX
 */
export const generateInvoiceNumber = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const random = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `INV-${year}-${month}-${random}`;
};

/**
 * Generate PDF invoice for subscription payment
 * @param {Object} paymentData - Payment and vendor details
 * @returns {string} Base64 encoded PDF
 */
const formatMoney = (v) => {
  const n = Number(v || 0);
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const generateInvoicePDF = (paymentData) => {
  const {
    invoiceNumber,
    invoiceDate,
    dueDate,
    vendor,
    plan,
    amount,
    discount_amount = 0,
    coupon_code = '',
    tax = 0,
    totalAmount,
    paymentMethod = 'Razorpay',
    transactionId,
  } = paymentData;

  const baseAmount = Number(amount || 0);
  const discountValue = Number(discount_amount || 0);
  const netAmount = Number.isFinite(totalAmount) ? Number(totalAmount) : Math.max(0, baseAmount - discountValue);
  const taxAmount = Number(tax || 0);
  const payableAmount = netAmount + taxAmount;
  const couponLabel = (coupon_code || '').toString().trim();

  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'A4',
  });

  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  let yPosition = 18;

  // Header - Company Info
  pdf.setFontSize(19);
  pdf.setTextColor(41, 128, 185);
  pdf.text('INDIAN TRADE MART', pageWidth / 2, yPosition, { align: 'center' });
  yPosition += 8;

  pdf.setFontSize(10);
  pdf.setTextColor(100, 100, 100);
  pdf.text('Invoice for Vendor Subscription', pageWidth / 2, yPosition, { align: 'center' });
  yPosition += 10;

  pdf.setDrawColor(220);
  pdf.line(18, yPosition, pageWidth - 18, yPosition);
  yPosition += 8;

  // Invoice Details
  pdf.setTextColor(0, 0, 0);
  pdf.setFontSize(11);
  pdf.text(`Invoice #: ${invoiceNumber}`, 20, yPosition);
  pdf.text(`Date: ${new Date(invoiceDate).toLocaleDateString('en-IN')}`, pageWidth / 2, yPosition);
  yPosition += 7;
  pdf.text(`Due Date: ${new Date(dueDate).toLocaleDateString('en-IN')}`, 20, yPosition);
  if (couponLabel) {
    pdf.setTextColor(46, 125, 50);
    pdf.text(`Coupon: ${couponLabel}`, pageWidth / 2, yPosition);
    pdf.setTextColor(0, 0, 0);
  }
  yPosition += 12;

  // Vendor Details
  pdf.setFontSize(10);
  pdf.setFont(undefined, 'bold');
  pdf.text('Bill To:', 20, yPosition);
  yPosition += 8;
  pdf.setFont(undefined, 'normal');
  pdf.text(`${vendor?.company_name || 'N/A'}`, 20, yPosition);
  yPosition += 6;
  pdf.text(`Email: ${vendor?.email || 'N/A'}`, 20, yPosition);
  yPosition += 6;
  pdf.text(`Phone: ${vendor?.phone || 'N/A'}`, 20, yPosition);
  yPosition += 6;
  if (vendor?.address) {
    pdf.text(`Address: ${vendor.address}`, 20, yPosition);
    yPosition += 6;
  }
  if (vendor?.gst_number) {
    pdf.text(`GST: ${vendor.gst_number}`, 20, yPosition);
    yPosition += 6;
  }
  yPosition += 8;
  pdf.setDrawColor(235);
  pdf.line(18, yPosition, pageWidth - 18, yPosition);
  yPosition += 8;

  // Line items table
  const tableStartY = yPosition;
  const colWidths = [80, 35, 35, 35];
  const cols = ['Description', 'Quantity', 'Rate', 'Amount'];

  pdf.setFontSize(11);
  pdf.setFont(undefined, 'bold');
  pdf.setFillColor(230, 230, 230);

  let xPos = 20;
  cols.forEach((col, idx) => {
    pdf.rect(xPos, tableStartY, colWidths[idx], 8, 'F');
    pdf.text(col, xPos + 2, tableStartY + 6);
    xPos += colWidths[idx];
  });

  yPosition = tableStartY + 10;
  pdf.setFont(undefined, 'normal');
  pdf.setFontSize(10);

  // Item row
  const itemName = `${plan?.name || 'Subscription'} Plan`;
  pdf.text(itemName, 22, yPosition);
  pdf.text('1', 100 + 8, yPosition, { align: 'center' });
  pdf.text(formatMoney(baseAmount), 135 + 8, yPosition, { align: 'right' });
  pdf.text(formatMoney(baseAmount), 170 + 8, yPosition, { align: 'right' });

  yPosition += 15;

  // Totals section
  const totalX = 135;
  pdf.setFont(undefined, 'normal');
  pdf.setFontSize(10);
  pdf.text('Subtotal:', totalX, yPosition);
  pdf.text(formatMoney(baseAmount), 170 + 8, yPosition, { align: 'right' });
  yPosition += 8;

  if (discountValue > 0) {
    pdf.text(`Discount${couponLabel ? ` (${couponLabel})` : ''}:`, totalX, yPosition);
    pdf.text(`-${formatMoney(discountValue)}`, 170 + 8, yPosition, { align: 'right' });
    yPosition += 8;
    pdf.text('Net after discount:', totalX, yPosition);
    pdf.text(formatMoney(netAmount), 170 + 8, yPosition, { align: 'right' });
    yPosition += 8;
  }

  if (taxAmount > 0) {
    pdf.text('Tax:', totalX, yPosition);
    pdf.text(formatMoney(taxAmount), 170 + 8, yPosition, { align: 'right' });
    yPosition += 8;
  }

  pdf.setFont(undefined, 'bold');
  pdf.setFontSize(11);
  pdf.text('Total Amount:', totalX, yPosition);
  pdf.text(formatMoney(payableAmount), 170 + 8, yPosition, { align: 'right' });
  yPosition += 12;

  // Payment Details
  pdf.setFont(undefined, 'bold');
  pdf.setFontSize(10);
  pdf.text('Payment Information:', 20, yPosition);
  yPosition += 8;

  pdf.setFont(undefined, 'normal');
  pdf.setFontSize(9);
  pdf.text(`Payment Method: ${paymentMethod}`, 20, yPosition);
  yPosition += 6;
  if (transactionId) {
    pdf.text(`Transaction ID: ${transactionId}`, 20, yPosition);
    yPosition += 6;
  }
  pdf.text(`Payment Date: ${new Date().toLocaleDateString('en-IN')}`, 20, yPosition);
  yPosition += 12;

  // Terms
  pdf.setFontSize(9);
  pdf.setTextColor(100, 100, 100);
  const termsText = 'This is an electronically generated invoice. No signature is required.';
  pdf.text(termsText, pageWidth / 2, pageHeight - 20, { align: 'center', maxWidth: 150 });

  // Footer
  pdf.setFontSize(8);
  pdf.text('For inquiries, contact support@indiantrademart.com', pageWidth / 2, pageHeight - 10, { align: 'center' });

  return pdf.output('dataurlstring');
};

/**
 * Generate invoice summary for email
 */
export const generateInvoiceSummary = (paymentData) => {
  const { invoiceNumber, vendor, plan, amount, totalAmount, discount_amount = 0, coupon_code = '' } = paymentData;
  const gross = Number(amount || 0);
  const discountValue = Number(discount_amount || 0);
  const net = Number.isFinite(totalAmount) ? Number(totalAmount) : Math.max(0, gross - discountValue);
  const couponLine =
    discountValue > 0
      ? `<p><strong>Coupon:</strong> ${coupon_code || 'N/A'} (₹${discountValue.toFixed(2)} off)</p>`
      : '';
  return `
    <h3>Invoice: ${invoiceNumber}</h3>
    <p><strong>Vendor:</strong> ${vendor?.company_name || 'N/A'}</p>
    <p><strong>Plan:</strong> ${plan?.name || 'N/A'}</p>
    <p><strong>Gross:</strong> ₹${gross.toFixed(2)}</p>
    ${couponLine}
    <p><strong>Paid:</strong> ₹${net.toFixed(2)}</p>
    <p><strong>Status:</strong> Completed</p>
  `;
};
