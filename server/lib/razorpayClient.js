import Razorpay from 'razorpay';

const configured = Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

let razorpayInstance;
if (configured) {
  razorpayInstance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
} else {
  console.warn('⚠️  Razorpay keys not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in backend/.env.local');
  const notConfigured = async () => {
    throw new Error('Razorpay not configured: set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in backend/.env.local');
  };
  razorpayInstance = {
    orders: { create: notConfigured, fetch: notConfigured },
    payments: { capture: notConfigured, fetch: notConfigured },
  };
}

export { razorpayInstance, configured as razorpayConfigured };
