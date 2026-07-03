require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const cashfree = require('./cashfree');
const telegram = require('./telegramBot');

const app = express();

// Serve the landing page (public/index.html) and any other static assets
app.use(express.static('public'));

app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------
app.get('/', (req, res) => {
  res.send('Mishkaa subscription backend is running.');
});

// ---------------------------------------------------------
// STEP 1: Frontend calls this when user clicks "Subscribe now"
// Body: { email, phone, name }
// Returns: { authorization_link } — redirect the user's browser there
// ---------------------------------------------------------
app.post('/api/create-subscription', async (req, res) => {
  try {
    const { email, phone, name } = req.body;

    if (!email || !phone) {
      return res.status(400).json({ error: 'email and phone are required' });
    }

    const subscriptionId = `mishkaa_${Date.now()}`;

    const result = await cashfree.createSubscription({
      subscriptionId,
      customerEmail: email,
      customerPhone: phone,
      customerName: name
    });

    console.log('Cashfree raw response:', JSON.stringify(result));

    // Save a pending record so we can match it up when the webhook fires
    await supabase.from('subscribers').insert({
      subscription_id: subscriptionId,
      customer_email: email,
      customer_phone: phone,
      status: 'pending'
    });

    res.json({
      authorization_link: result.authorization_details?.authorization_link,
      subscription_id: subscriptionId
    });
  } catch (err) {
    console.error('create-subscription error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------
// STEP 2: Cashfree redirects the customer here after they approve
// the mandate. We just show a friendly message — the actual access
// grant happens via webhook below, which is more reliable than
// trusting the redirect alone.
// ---------------------------------------------------------
app.get('/subscription-return', (req, res) => {
  res.send(`
    <html>
      <body style="background:#0b0708;color:#f7efe9;font-family:sans-serif;text-align:center;padding:60px 20px;">
        <h2>Thank you!</h2>
        <p>Your subscription is being confirmed. You'll receive your private
        Telegram group invite link on your registered email/phone within a
        minute or two.</p>
      </body>
    </html>
  `);
});

// ---------------------------------------------------------
// STEP 3: Cashfree webhook — fires on subscription/payment events
// ---------------------------------------------------------
app.post('/webhook/cashfree', async (req, res) => {
  try {
    // Verify signature using the Client Secret
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    const expectedSignature = crypto
      .createHmac('sha256', process.env.CASHFREE_CLIENT_SECRET)
      .update(timestamp + req.rawBody)
      .digest('base64');

    if (signature !== expectedSignature) {
      console.warn('Invalid webhook signature — ignoring');
      return res.status(401).send('Invalid signature');
    }

    const event = req.body;
    const eventType = event.type;
    const subscriptionId = event.data?.subscription?.subscription_id
      || event.data?.subscription_id;

    console.log('Webhook received:', eventType, subscriptionId);

    if (!subscriptionId) {
      return res.status(200).send('No subscription_id in payload, ignored');
    }

    // Subscription activated OR a recurring payment succeeded —
    // grant/renew access
    if (
      eventType === 'SUBSCRIPTION_STATUS_CHANGE' &&
      event.data?.subscription?.subscription_status === 'ACTIVE'
    ) {
      await grantOrRenewAccess(subscriptionId, event);
    }

    if (eventType === 'SUBSCRIPTION_PAYMENT_SUCCESS') {
      await grantOrRenewAccess(subscriptionId, event);
    }

    // Payment failed, cancelled, or subscription otherwise stopped —
    // revoke access
    if (
      eventType === 'SUBSCRIPTION_PAYMENT_FAILED' ||
      eventType === 'SUBSCRIPTION_PAYMENT_CANCELLED' ||
      (eventType === 'SUBSCRIPTION_STATUS_CHANGE' &&
        ['CANCELLED', 'EXPIRED', 'ON_HOLD'].includes(event.data?.subscription?.subscription_status))
    ) {
      await revokeAccess(subscriptionId);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Server error');
  }
});

async function grantOrRenewAccess(subscriptionId, event) {
  const { data: existing } = await supabase
    .from('subscribers')
    .select('*')
    .eq('subscription_id', subscriptionId)
    .maybeSingle();

  if (!existing) {
    console.warn(`No local record for subscription ${subscriptionId}`);
    return;
  }

  const now = new Date();
  const nextCycle = new Date(now);
  nextCycle.setDate(nextCycle.getDate() + 30); // grace window past next expected charge

  let inviteLink = existing.invite_link;

  // Only generate a fresh invite link the first time (subscription just activated)
  if (existing.status !== 'active') {
    inviteLink = await telegram.generateInviteLink();
    // TODO: send inviteLink to existing.customer_email / customer_phone
    console.log(`Invite link for ${existing.customer_email}: ${inviteLink}`);
  }

  await supabase
    .from('subscribers')
    .update({
      status: 'active',
      expires_at: nextCycle.toISOString(),
      invite_link: inviteLink,
      last_payment_at: now.toISOString()
    })
    .eq('subscription_id', subscriptionId);
}

async function revokeAccess(subscriptionId) {
  const { data: existing } = await supabase
    .from('subscribers')
    .select('*')
    .eq('subscription_id', subscriptionId)
    .maybeSingle();

  if (!existing) return;

  if (existing.telegram_user_id) {
    await telegram.removeUserFromGroup(existing.telegram_user_id);
  }
  await telegram.revokeInviteLink(existing.invite_link);

  await supabase
    .from('subscribers')
    .update({ status: 'expired' })
    .eq('subscription_id', subscriptionId);
}

// ---------------------------------------------------------
// Telegram webhook — captures the telegram_user_id of whoever joins
// via one of our invite links, by matching the invite_link string.
// This must be registered with Telegram once via setWebhook (see README).
// ---------------------------------------------------------
app.post('/webhook/telegram', async (req, res) => {
  try {
    const update = req.body;
    const chatMember = update.chat_member;

    if (
      chatMember &&
      chatMember.new_chat_member?.status === 'member' &&
      chatMember.invite_link?.invite_link
    ) {
      const joinedLink = chatMember.invite_link.invite_link;
      const userId = chatMember.new_chat_member.user.id;

      await supabase
        .from('subscribers')
        .update({ telegram_user_id: String(userId) })
        .eq('invite_link', joinedLink);

      console.log(`Linked telegram_user_id ${userId} to invite link ${joinedLink}`);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Telegram webhook error:', err);
    res.status(500).send('Server error');
  }
});

// ---------------------------------------------------------
// Safety net cron — in case a webhook is ever missed, this catches
// anyone whose expires_at has passed and removes them.
// Call daily via Render Cron Job or an external scheduler.
// ---------------------------------------------------------
app.post('/cron/check-expired', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  try {
    const now = new Date().toISOString();
    const { data: expiredUsers, error } = await supabase
      .from('subscribers')
      .select('*')
      .eq('status', 'active')
      .lt('expires_at', now);

    if (error) throw error;

    for (const user of expiredUsers) {
      await revokeAccess(user.subscription_id);
    }

    res.status(200).json({ removed: expiredUsers.length });
  } catch (err) {
    console.error('Cron error:', err);
    res.status(500).send('Server error');
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
