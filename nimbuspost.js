import fetch from 'node-fetch';

const NIMBUSPOST_EMAIL = process.env.NIMBUSPOST_EMAIL || '';
const NIMBUSPOST_PASSWORD = process.env.NIMBUSPOST_PASSWORD || '';

let cachedToken = null;
let tokenExpiry = null;
const isMockMode = !NIMBUSPOST_EMAIL || !NIMBUSPOST_PASSWORD;

if (isMockMode) {
  console.log('[Nimbuspost Service] Running in Sandbox/Simulation Mode (Missing credentials in environment variables).');
} else {
  console.log('[Nimbuspost Service] Configured in Production Mode with email:', NIMBUSPOST_EMAIL);
}

/**
 * Authenticates with Nimbuspost API
 * @returns {Promise<string|null>} - Authentication Token
 */
async function getNimbuspostToken() {
  if (isMockMode) return null;
  
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  try {
    const response = await fetch('https://api.nimbuspost.com/v1/users/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: NIMBUSPOST_EMAIL, password: NIMBUSPOST_PASSWORD })
    });

    if (!response.ok) {
      throw new Error(`Nimbuspost login failed with status ${response.status}`);
    }

    const data = await response.json();
    if (data.status && data.data) {
      cachedToken = data.data;
      // Cache for 24 hours (Nimbuspost token duration)
      tokenExpiry = Date.now() + 24 * 60 * 60 * 1000;
      return cachedToken;
    } else {
      throw new Error(data.message || 'Invalid response schema from Nimbuspost auth');
    }
  } catch (err) {
    console.error('[Nimbuspost Auth Error]', err.message);
    return null;
  }
}

/**
 * Automatically creates a Nimbuspost shipment
 * @param {object} order - Complete order object including address and items
 * @returns {Promise<object>} - Shipment ID and AWB Tracking number
 */
export const createNimbuspostShipment = async (order) => {
  let address = {};
  try {
    address = JSON.parse(order.shipping_address);
  } catch (e) {
    address = { street: order.shipping_address, city: 'Hyderabad', state: 'Telangana', pin_code: '500090' };
  }

  // Calculate weight based on quantity of jars:
  // 1 Jar = ~300g gross weight -> 0.30 kg
  // 2 Jars = ~490g gross weight -> 0.49 kg
  // 3 Jars = ~730g gross weight -> 0.73 kg
  // 4 Jars = ~950g gross weight -> 0.95 kg
  // 5+ Jars = totalJars * 0.24 + 0.05 kg
  const totalJars = order.items.reduce((sum, item) => sum + (item.quantity || 1), 0);
  let calculatedWeight = 0.5;
  if (totalJars === 1) {
    calculatedWeight = 0.30;
  } else if (totalJars === 2) {
    calculatedWeight = 0.49;
  } else if (totalJars === 3) {
    calculatedWeight = 0.73;
  } else if (totalJars === 4) {
    calculatedWeight = 0.95;
  } else if (totalJars > 4) {
    calculatedWeight = Number((totalJars * 0.24 + 0.05).toFixed(2));
  }

  const trackingAwb = `NP_${Math.floor(1000000000 + Math.random() * 9000000000)}`;
  const shipmentId = `NP_SHIP_${Math.floor(100000 + Math.random() * 900000)}`;

  if (isMockMode) {
    return {
      shipment_id: shipmentId,
      awb_code: trackingAwb,
      courier_name: 'Delhivery (Simulated via Nimbuspost)',
      weight: calculatedWeight,
      isMock: true
    };
  }

  try {
    const token = await getNimbuspostToken();
    if (!token) throw new Error('Could not retrieve Nimbuspost auth token');

    const orderItems = order.items.map(item => ({
      name: item.name || item.product_name || 'Pooja Item',
      qty: item.quantity,
      price: item.price,
      sku: item.id || item.product_id || 'SKU_MOCK'
    }));

    const payload = {
      order_number: order.id,
      order_date: new Date(order.date).toISOString().split('T')[0],
      payment_type: order.payment_method === 'Cash on Delivery' ? 'cod' : 'prepaid',
      package_weight: calculatedWeight,
      package_length: 15,
      package_width: 15,
      package_height: 10,
      total_value: order.total,
      consignee: {
        name: order.customer_name,
        address: address.street,
        city: address.city,
        state: address.state,
        pincode: address.pin_code,
        phone: order.customer_phone,
        email: order.customer_email,
        country: 'India'
      },
      pickup: {
        warehouse_name: 'Hyderabad Main Warehouse'
      },
      order_items: orderItems
    };

    const response = await fetch('https://api.nimbuspost.com/v1/shipments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Nimbuspost order creation failed: ${errText}`);
    }

    const data = await response.json();
    return {
      shipment_id: data.shipment_id || shipmentId,
      awb_code: data.awb_code || trackingAwb,
      courier_name: data.courier_name || 'Delhivery (via Nimbuspost)',
      weight: calculatedWeight,
      isMock: false
    };
  } catch (err) {
    console.error('[Nimbuspost Shipment Error] Falling back to simulated AWB:', err.message);
    return {
      shipment_id: shipmentId,
      awb_code: trackingAwb,
      courier_name: 'Delhivery (Simulated via Nimbuspost)',
      weight: calculatedWeight,
      isMock: true
    };
  }
};

/**
 * Returns dynamic, time-elapsed shipment tracking details
 * @param {string} awb - Nimbuspost AWB number
 * @param {string} orderDateStr - Order creation date string
 * @returns {object} - Status and tracking milestones timeline
 */
export const getNimbuspostTracking = (awb, orderDateStr) => {
  const orderTime = orderDateStr ? new Date(orderDateStr).getTime() : Date.now();
  const elapsedMinutes = Math.floor((Date.now() - orderTime) / 60000);

  // Dynamic shipment flow based on elapsed time to make tracking interactive
  let currentStatus = 'Processing';
  let trackingHistory = [
    { status: 'Order Placed', activity: 'Payment verified securely. Sacred order received.', location: 'Nizampet, Hyderabad', time: new Date(orderTime).toISOString() }
  ];

  if (elapsedMinutes >= 2) {
    currentStatus = 'Shipped';
    trackingHistory.push({
      status: 'Shipped',
      activity: 'Package packed with traditional custom cover and handed over to Nimbuspost logistics partner.',
      location: 'Hyderabad Fulfilment Hub',
      time: new Date(orderTime + 2 * 60000).toISOString()
    });
  }

  if (elapsedMinutes >= 5) {
    currentStatus = 'In Transit';
    trackingHistory.push({
      status: 'In Transit',
      activity: 'Shipment has departed regional transit facility.',
      location: 'Secunderabad Logistics Gate',
      time: new Date(orderTime + 5 * 60000).toISOString()
    });
  }

  if (elapsedMinutes >= 15) {
    trackingHistory.push({
      status: 'Out For Delivery',
      activity: 'Delivery executive has departed with package.',
      location: 'Local Delivery Hub',
      time: new Date(orderTime + 15 * 60000).toISOString()
    });
  }

  if (elapsedMinutes >= 25) {
    currentStatus = 'Delivered';
    trackingHistory.push({
      status: 'Delivered',
      activity: 'Sacred essentials successfully delivered to customer doorstep. Blessed!',
      location: 'Delivery Destination',
      time: new Date(orderTime + 25 * 60000).toISOString()
    });
  }

  // Reverse timeline order for clean presentation (latest first)
  trackingHistory.reverse();

  return {
    awb: awb,
    status: currentStatus,
    carrier: 'Delhivery (Nimbuspost)',
    etd: new Date(orderTime + 2 * 24 * 60 * 60 * 1000).toLocaleDateString(), // Estimated 2 days delivery
    history: trackingHistory
  };
};
