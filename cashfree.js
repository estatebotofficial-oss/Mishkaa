require('dotenv').config();
const fetch = require('node-fetch');

const CF_BASE_URL = process.env.CASHFREE_ENV === 'PROD'
  ? 'https://api.cashfree.com/pg'
  : 'https://sandbox.cashfree.com/pg';

const HEADERS = {
  'Content-Type': 'application/json',
  'x-api-version': '2025-01-01',
  'x-client-id': process.env.CASHFREE_CLIENT_ID,
  'x-client-secret': process.env.CASHFREE_CLIENT_SECRET
};

/**
 * Creates a new subscription for a customer against the pre-created Plan.
 * This returns an authorization link — the customer must open this link
 * and approve the mandate (usually via a small auth-amount charge or
 * e-mandate) before the subscription becomes ACTIVE and recurring
 * charges begin.
 *
 * NOTE: Field names below follow Cashfree's Subscriptions v2025-01-01
 * structure at the time this was written. Cashfree occasionally tweaks
 * field names — if a call fails, check the exact request body in their
 * Subscriptions API reference and adjust here.
 */
async function createSubscription({ subscriptionId, customerEmail, customerPhone, customerName }) {
  const body = {
    subscription_id: subscriptionId,
    plan_details: {
      plan_id: process.env.CASHFREE_PLAN_ID
    },
    customer_details: {
      customer_name: customerName || 'Subscriber',
      customer_email: customerEmail,
      customer_phone: customerPhone
    },
    authorization_details: {
      authorization_amount: 1, // small token amount to set up the mandate
      authorization_amount_refund: true
    },
    subscription_meta: {
      return_url: process.env.SUBSCRIPTION_RETURN_URL // page shown after auth
    }
  };

  const res = await fetch(`${CF_BASE_URL}/subscriptions`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Cashfree createSubscription error: ${JSON.stringify(data)}`);
  }
  return data; // contains authorization_details.authorization_link
}

/**
 * Fetches current status/details of a subscription by ID.
 */
async function getSubscription(subscriptionId) {
  const res = await fetch(`${CF_BASE_URL}/subscriptions/${subscriptionId}`, {
    method: 'GET',
    headers: HEADERS
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Cashfree getSubscription error: ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Cancels a subscription (stops future recurring charges).
 */
async function cancelSubscription(subscriptionId) {
  const res = await fetch(`${CF_BASE_URL}/subscriptions/${subscriptionId}/cancel`, {
    method: 'POST',
    headers: HEADERS
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Cashfree cancelSubscription error: ${JSON.stringify(data)}`);
  }
  return data;
}

module.exports = {
  createSubscription,
  getSubscription,
  cancelSubscription
};
