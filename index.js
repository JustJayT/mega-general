require('dotenv').config();
const { Client, GatewayIntentBits, Events, Partials } = require('discord.js');
const fs = require('fs');
const path = require('path');

// ── CONFIG ────────────────────────────────────────────────
// Test mode is toggled with `node channels.js toggle` (writes mode.json).
// Blacklisted user IDs live in blacklist.json (a JSON array of ID strings);
// their messages stay in their own server and are never relayed.
const MODE_FILE = path.join(__dirname, 'mode.json');
const BLACKLIST_FILE = path.join(__dirname, 'blacklist.json');

function inTestMode() {
  try {
    return JSON.parse(fs.readFileSync(MODE_FILE, 'utf8')).testMode === true;
  } catch {
    return false;
  }
}

function activeChannelsFile() {
  return path.join(__dirname, inTestMode() ? 'test-channels.json' : 'channels.json');
}

let BRIDGED_CHANNELS = [];
let CHANNEL_TAGS = new Map();
let BLACKLIST = new Set();

function loadChannels() {
  const testMode = inTestMode();
  const file = activeChannelsFile();
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    BRIDGED_CHANNELS = data.map((c) => c.id);
    CHANNEL_TAGS = new Map(data.map((c) => [c.id, c.label || '']));
    console.log(`[${testMode ? 'TEST' : 'LIVE'}] Loaded ${BRIDGED_CHANNELS.length} bridged channels.`);
  } catch (err) {
    console.error(`Could not read ${path.basename(file)}:`, err.message);
    BRIDGED_CHANNELS = [];
    CHANNEL_TAGS = new Map();
  }
}

function loadBlacklist() {
  try {
    BLACKLIST = new Set(JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8')));
    console.log(`Blacklist: ${BLACKLIST.size} user(s).`);
  } catch {
    BLACKLIST = new Set();
  }
}

loadChannels();
loadBlacklist();
for (const f of ['mode.json', 'channels.json', 'test-channels.json']) {
  fs.watchFile(path.join(__dirname, f), { interval: 1000 }, loadChannels);
}
fs.watchFile(BLACKLIST_FILE, { interval: 1000 }, loadBlacklist);
// ──────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});
require('./roles.js')(client);
const webhookCache = new Map();

// messageId -> [{ channelId, messageId }, ...] linking every copy together.
const linkGroups = new Map();
const LINK_CAP = 3000;

function rememberGroup(group) {
  for (const entry of group) linkGroups.set(entry.messageId, group);
  while (linkGroups.size > LINK_CAP) {
    linkGroups.delete(linkGroups.keys().next().value);
  }
}

async function getRelayWebhook(channel) {
  if (webhookCache.has(channel.id)) return webhookCache.get(channel.id);
  const hooks = await channel.fetchWebhooks();
  let hook = hooks.find((h) => h.owner?.id === client.user.id && h.name === 'Bridge');
  if (!hook) hook = await channel.createWebhook({ name: 'Bridge' });
  webhookCache.set(channel.id, hook);
  return hook;
}

function safeName(name) {
  const cleaned = name.replace(/discord|clyde/gi, '\u200b$&').slice(0, 80);
  return cleaned.trim() || 'User';
}

function emojiToken(emoji) {
  if (!emoji.id) return emoji.name;
  return `${emoji.animated ? 'a:' : ''}${emoji.name}:${emoji.id}`;
}

// Gather reply context once: who/what is being replied to, plus the link
// group of that message so we can build a per-server jump link.
async function getReplyContext(message) {
  if (!message.reference?.messageId) return null;
  const refId = message.reference.messageId;

  let ref;
  try {
    ref = await message.channel.messages.fetch(refId);
  } catch {
    return null;
  }

  const refName = ref.member?.displayName ?? ref.author?.username ?? 'someone';
  const withoutQuote = (ref.content || '')
    .split('\n')
    .filter((line) => !line.startsWith('> \u21a9\ufe0f'))
    .join('\n');
  let snippet = withoutQuote.replace(/\n/g, ' ').replace(/[\[\]]/g, '').trim();
  if (!snippet && ref.attachments.size > 0) snippet = '[attachment]';
  if (snippet.length > 80) snippet = snippet.slice(0, 77) + '...';

  return { refName, snippet, group: linkGroups.get(refId) || null };
}

// Build the quote line for one destination. If we know the replied-to
// message's copy in that destination's server, hyperlink to it.
function formatReplyQuote(ctx, destChannelId, destGuildId) {
  if (!ctx) return '';
  const sibling = ctx.group?.find((e) => e.channelId === destChannelId);
  if (sibling && destGuildId) {
    const url = `https://discord.com/channels/${destGuildId}/${destChannelId}/${sibling.messageId}`;
    return `> \u21a9\ufe0f [${ctx.refName}: ${ctx.snippet}](${url})\n`;
  }
  return `> \u21a9\ufe0f **${ctx.refName}**: ${ctx.snippet}\n`;
}

client.once(Events.ClientReady, (c) => {
  console.log(`Bridge online as ${c.user.tag}`);
  console.log(`Mode: ${inTestMode() ? 'TEST (test-channels.json)' : 'LIVE (channels.json)'}`);
  console.log(`Bridging ${BRIDGED_CHANNELS.length} channels.`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.webhookId) return;
  if (!BRIDGED_CHANNELS.includes(message.channel.id)) return;
  if (BLACKLIST.has(message.author.id)) return; // blacklisted: stays local only
  if (!message.content && message.attachments.size === 0) return;

  const authorName = message.member?.displayName ?? message.author.username;
  const tag = CHANNEL_TAGS.get(message.channel.id) || message.guild?.name || 'Unknown';
  const displayName = safeName(`${authorName} \u2022 ${tag}`);
  const avatarURL = message.author.displayAvatarURL();
  const files = [...message.attachments.values()].map((a) => a.url);

  const replyCtx = await getReplyContext(message);
  const group = [{ channelId: message.channel.id, messageId: message.id }];

  for (const channelId of BRIDGED_CHANNELS) {
    if (channelId === message.channel.id) continue;

    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased()) continue;

      const webhook = await getRelayWebhook(channel);
      const quote = formatReplyQuote(replyCtx, channelId, channel.guildId);
      const content = `${quote}${message.content || ''}` || undefined;

      const sent = await webhook.send({
        content,
        username: displayName,
        avatarURL,
        files,
        allowedMentions: { parse: [] },
      });
      if (sent?.id) group.push({ channelId, messageId: sent.id });
    } catch (err) {
      console.error(`Failed to relay to ${channelId}:`, err.message);
    }
  }

  if (group.length > 1) rememberGroup(group);
});

async function mirrorReaction(reaction, user, action) {
  if (user.bot) return;
  if (reaction.partial) {
    try { await reaction.fetch(); } catch { return; }
  }

  const group = linkGroups.get(reaction.message.id);
  if (!group) return;

  const token = emojiToken(reaction.emoji);
  const emojiKey = reaction.emoji.id ?? reaction.emoji.name;

  for (const sibling of group) {
    if (sibling.messageId === reaction.message.id) continue;
    try {
      const channel = await client.channels.fetch(sibling.channelId);
      const msg = await channel.messages.fetch(sibling.messageId);
      if (action === 'add') {
        await msg.react(token);
      } else {
        const r = msg.reactions.cache.find((x) => (x.emoji.id ?? x.emoji.name) === emojiKey);
        if (r) await r.users.remove(client.user.id);
      }
    } catch (err) {
      console.error(`Reaction mirror failed for ${sibling.messageId}:`, err.message);
    }
  }
}

client.on(Events.MessageReactionAdd, (reaction, user) => mirrorReaction(reaction, user, 'add'));
client.on(Events.MessageReactionRemove, (reaction, user) => mirrorReaction(reaction, user, 'remove'));

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  if (newMessage.partial) {
    try { newMessage = await newMessage.fetch(); } catch { return; }
  }
  if (newMessage.author?.bot || newMessage.webhookId) return;

  const group = linkGroups.get(newMessage.id);
  if (!group) return;
  if (oldMessage && !oldMessage.partial && oldMessage.content === newMessage.content) return;

  const replyCtx = await getReplyContext(newMessage);

  for (const sibling of group) {
    if (sibling.channelId === newMessage.channel.id) continue;
    try {
      const channel = await client.channels.fetch(sibling.channelId);
      const webhook = await getRelayWebhook(channel);
      const quote = formatReplyQuote(replyCtx, sibling.channelId, channel.guildId);
      const content = `${quote}${newMessage.content || ''}` || undefined;
      await webhook.editMessage(sibling.messageId, { content, allowedMentions: { parse: [] } });
    } catch (err) {
      console.error(`Edit mirror failed for ${sibling.messageId}:`, err.message);
    }
  }
});

client.on(Events.MessageDelete, async (message) => {
  const group = linkGroups.get(message.id);
  if (!group) return;

  const original = group[0];
  if (message.id !== original.messageId) return;

  for (const entry of group) linkGroups.delete(entry.messageId);

  for (const sibling of group) {
    if (sibling.messageId === original.messageId) continue;
    try {
      const channel = await client.channels.fetch(sibling.channelId);
      const webhook = await getRelayWebhook(channel);
      await webhook.deleteMessage(sibling.messageId);
    } catch (err) {
      console.error(`Delete mirror failed for ${sibling.messageId}:`, err.message);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);