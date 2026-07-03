require('dotenv').config();
const fetch = require('node-fetch');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID = process.env.TELEGRAM_GROUP_ID; // e.g. -1004348087916
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

/**
 * Creates a single-use invite link. member_limit: 1 makes it auto-invalidate
 * after one person joins.
 */
async function generateInviteLink() {
  const res = await fetch(`${TELEGRAM_API}/createChatInviteLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: GROUP_ID,
      member_limit: 1,
      name: `sub-${Date.now()}`
    })
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  }
  return data.result.invite_link;
}

async function revokeInviteLink(inviteLink) {
  if (!inviteLink) return;
  await fetch(`${TELEGRAM_API}/revokeChatInviteLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: GROUP_ID, invite_link: inviteLink })
  });
}

async function removeUserFromGroup(telegramUserId) {
  await fetch(`${TELEGRAM_API}/banChatMember`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: GROUP_ID, user_id: telegramUserId })
  });
  await fetch(`${TELEGRAM_API}/unbanChatMember`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: GROUP_ID, user_id: telegramUserId, only_if_banned: true })
  });
}

/**
 * Registers a webhook URL with Telegram so it pushes updates to our
 * server (including chat_member events — used to capture the
 * telegram_user_id of whoever joins via an invite link).
 * Run this once manually after deploying (see README).
 */
async function setWebhook(url) {
  const res = await fetch(`${TELEGRAM_API}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      allowed_updates: ['chat_member', 'message']
    })
  });
  return res.json();
}

async function sendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
}

module.exports = {
  generateInviteLink,
  revokeInviteLink,
  removeUserFromGroup,
  setWebhook,
  sendMessage
};
