import Razorpay from 'razorpay';
import crypto from 'crypto';

const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';

let razorpay = null;
const isMockMode = !KEY_ID || !KEY_SECRET;

if (!isMockMode) {
  try {
    razorpay = new Razorpay({
      key_id: KEY_ID,
      key_secret: KEY_SECRET,
    });
    console.log('[Razorpay Service] Initialized successfully in Production Mode.');
  } catch (err) {
    console.error('[Razorpay Service] Error initializing Razorpay SDK:', err.message);
  }
} else {
  console.log('[Razorpay Service] Running in Sandbox/Simulation Mode (Missing keys in environment variables).');
}

/**
 * Creates a Razorpay Order
 * @param {number} amount - Amount in INR (Rupees)
 * @returns {Promise<object>} - Created order details
 */
export const createRazorpayOrder = async (amount) => {
  const amountInPaise = Math.round(amount * 100);
  const receipt = `rcpt_${Math.random().toString(36).substr(2, 9)}`;

  if (isMockMode) {
    // Generate simulated Razorpay Order
    const mockOrderId = `order_${Math.random().toString(36).substr(2, 14)}`;
    return {
      id: mockOrderId,
      entity: 'order',
      amount: amountInPaise,
      amount_paid: 0,
      amount_due: amountInPaise,
      currency: 'INR',
      receipt: receipt,
      status: 'created',
      attempts: 0,
      notes: { info: 'Simulated Order' },
      created_at: Math.floor(Date.now() / 1000),
      isMock: true
    };
  }

  // Real API Call
  return new Promise((resolve, reject) => {
    razorpay.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt: receipt,
      payment_capture: 1
    }, (err, order) => {
      if (err) reject(err);
      else resolve({ ...order, isMock: false });
    });
  });
};

/**
 * Verifies Razorpay Payment Signature
 * @param {string} orderId - Razorpay Order ID
 * @param {string} paymentId - Razorpay Payment ID
 * @param {string} signature - Razorpay Signature
 * @returns {boolean} - Signature match status
 */
export const verifyRazorpaySignature = (orderId, paymentId, signature) => {
  if (isMockMode) {
    // Sandbox verification always accepts valid structured strings
    return orderId && paymentId && signature;
  }

  try {
    const generated_signature = crypto
      .createHmac('sha256', KEY_SECRET)
      .update(orderId + '|' + paymentId)
      .digest('hex');
    
    return generated_signature === signature;
  } catch (err) {
    console.error('[Razorpay Signature Verification Error]', err);
    return false;
  }
};

export const getRazorpayKey = () => {
  return KEY_ID || 'rzp_test_mockKeyId';
};
export { isMockMode };
