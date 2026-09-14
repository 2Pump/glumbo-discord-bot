import fs from "node:fs";
import http from "node:http";
import process from "node:process";
import { createHolderVerification } from "./holder-verification.mjs";

const DEFAULT_TOKEN = "0x78BABF93Be6bCc08112d5De69E115C877837b360";
const DEFAULT_SUBGRAPH =
  "https://api.goldsky.com/api/public/project_cmm7vh5xwsa8m01qmdr7w7u62/subgraphs/sentry-ink/1.6.0/gn";
const DEFAULT_IMAGE =
  "https://esjrycmiokijtxnbfyox.supabase.co/storage/v1/object/public/solana-logos/762520d2-81ae-49d7-9964-7a67c976d276-logo.png";

const config = {
  tokenAddress: (process.env.TOKEN_ADDRESS || DEFAULT_TOKEN).toLowerCase(),
  tokenSymbol: process.env.TOKEN_SYMBOL || "GLUMBO",
  minBuyUsd: numberEnv("MIN_BUY_USD", 0.01, 0),
  totalSupply: numberEnv("TOTAL_SUPPLY", 1_000_000_000, 0),
  pollMs: numberEnv("POLL_INTERVAL_MS", 5_000, 1_000),
  subgraphUrl: process.env.SUBGRAPH_URL || DEFAULT_SUBGRAPH,
  webhookUrl: process.env.DISCORD_WEBHOOK_URL || "",
  botUsername: process.env.BOT_USERNAME || "$GLUMBO Buy Bot",
  botAvatarUrl: process.env.BOT_AVATAR_URL || DEFAULT_IMAGE,
  imageUrl: process.env.IMAGE_URL || DEFAULT_IMAGE,
  stateFile: process.env.STATE_FILE || "./state.json",
  dryRun: boolEnv("DRY_RUN"),
  replayLatest: boolEnv("REPLAY_LATEST"),
  runOnce: boolEnv("RUN_ONCE"),
};

const BUY_QUERY = `
  query GlumboBuys($token: String!, $since: BigInt!, $skip: Int!) {
    swaps(
      first: 100
      skip: $skip
      orderBy: timestamp
      orderDirection: asc
      where: { token: $token, isBuy: true, timestamp_gte: $since }
    ) {
      id
      timestamp
      txHash
      origin
      amountToken
      amountWETH
      priceUsd
      token { symbol lastPriceUsd }
      pool { id version }
    }
  }
`;

const LATEST_QUERY = `
  query LatestGlumboBuy($token: String!) {
    swaps(
      first: 1
      orderBy: timestamp
      orderDirection: desc
      where: { token: $token, isBuy: true }
    ) {
      id
      timestamp
      txHash
      origin
      amountToken
      amountWETH
      priceUsd
      token { symbol lastPriceUsd }
      pool { id version }
    }
  }
`;

function numberEnv(name, fallback, minimum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be a number greater than or equal to ${minimum}.`);
  }
  return value;
}

function boolEnv(name) {
  return /^(1|true|yes)$/i.test(process.env[name] || "");
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function graphql(query, variables) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(config.subgraphUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Sentry index returned HTTP ${response.status}.`);
    const body = await response.json();
    if (body.errors?.length) {
      throw new Error(`Sentry index error: ${body.errors.map((error) => error.message).join("; ")}`);
    }
    return body.data;
  } finally {
    clearTimeout(timeout);
  }
}

async function latestBuy() {
  const data = await graphql(LATEST_QUERY, { token: config.tokenAddress });
  return data.swaps[0] || null;
}

async function buysSince(timestamp) {
  const all = [];
  for (let skip = 0; ; skip += 100) {
    const data = await graphql(BUY_QUERY, {
      token: config.tokenAddress,
      since: String(timestamp),
      skip,
    });
    all.push(...data.swaps);
    if (data.swaps.length < 100) break;
  }
  return all.sort((a, b) => Number(a.timestamp) - Number(b.timestamp) || a.id.localeCompare(b.id));
}

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(config.stateFile, "utf8"));
    if (!state.lastTimestamp || !Array.isArray(state.idsAtTimestamp)) throw new Error("Invalid state");
    return state;
  } catch (error) {
    if (error.code !== "ENOENT") log(`Ignoring unreadable state file: ${error.message}`);
    return null;
  }
}

function saveState(state) {
  const temporary = `${config.stateFile}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temporary, config.stateFile);
}

function recordSeen(state, buy) {
  const timestamp = String(buy.timestamp);
  if (BigInt(timestamp) > BigInt(state.lastTimestamp)) {
    state.lastTimestamp = timestamp;
    state.idsAtTimestamp = [buy.id];
  } else if (!state.idsAtTimestamp.includes(buy.id)) {
    state.idsAtTimestamp.push(buy.id);
  }
  saveState(state);
}

function isSeen(state, buy) {
  const buyTime = BigInt(buy.timestamp);
  const stateTime = BigInt(state.lastTimestamp);
  return buyTime < stateTime || (buyTime === stateTime && state.idsAtTimestamp.includes(buy.id));
}

function usdValue(buy) {
  return Math.abs(Number(buy.amountToken) * Number(buy.priceUsd));
}

function formatUsd(value) {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

function formatPrice(value) {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  if (value >= 0.0001) return `$${value.toFixed(8)}`;
  return `$${value.toFixed(10)}`;
}

function formatToken(value) {
  const number = Math.abs(Number(value));
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(number);
}

function shortAddress(address) {
  return `${address.slice(0, 6)}â¦${address.slice(-4)}`;
}

function buyMeter(value) {
  const count =
    value >= 5000 ? 5 :
    value >= 1000 ? 4 :
    value >= 500 ? 3 :
    value >= 100 ? 2 : 1;

  return "\u{1F7E2}".repeat(count);
}

function makePayload(buy) {
  const usd = usdValue(buy);
  const price = Math.abs(Number(buy.priceUsd));
  const marketCap = price * config.totalSupply;
  const txUrl = `https://explorer.inkonchain.com/tx/${buy.txHash}`;
  const buyerUrl = `https://explorer.inkonchain.com/address/${buy.origin}`;
  const tradeUrl = `https://www.sentry.trading/tokens?chain=ink&token=${config.tokenAddress}`;

  return {
    username: config.botUsername,
    avatar_url: config.botAvatarUrl,
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: `${buyMeter(usd)} $${config.tokenSymbol} BUY!`,
        url: tradeUrl,
        color: 0x8b5cf6,
        thumbnail: config.imageUrl ? { url: config.imageUrl } : undefined,
        fields: [
          { name: "Spent", value: `**${formatUsd(usd)}**`, inline: true },
          { name: `$${config.tokenSymbol} received`, value: `**${formatToken(buy.amountToken)}**`, inline: true },
          { name: "Execution price", value: formatPrice(price), inline: true },
          { name: "Est. FDV at buy", value: formatUsd(marketCap), inline: true },
          { name: "Buyer", value: `[${shortAddress(buy.origin)}](${buyerUrl})`, inline: true },
          { name: "Transaction", value: `[View on Ink Explorer](${txUrl})`, inline: true },
        ],
       footer: { text: "GLUMBO on Ink | Powered by Sentry | Holders earn wNVDAx" },
        timestamp: new Date(Number(buy.timestamp) * 1000).toISOString(),
      },
    ],
  };
}

async function sendAlert(buy) {
  const payload = makePayload(buy);
  if (config.dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (!config.webhookUrl) throw new Error("DISCORD_WEBHOOK_URL is required unless DRY_RUN=true.");

  const webhookUrl = new URL(config.webhookUrl);
  webhookUrl.searchParams.set("wait", "true");
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Discord returned HTTP ${response.status}: ${detail.slice(0, 300)}`);
  }
}

async function processBuy(state, buy) {
  if (isSeen(state, buy)) return;
  const usd = usdValue(buy);
  if (!Number.isFinite(usd)) {
    log(`Skipping ${buy.id}: could not calculate USD value.`);
  } else if (usd >= config.minBuyUsd) {
    await sendAlert(buy);
    log(`Alerted ${formatUsd(usd)} buy in ${buy.txHash}.`);
  } else {
    log(`Skipped ${formatUsd(usd)} buy below ${formatUsd(config.minBuyUsd)}.`);
  }
  recordSeen(state, buy);
}

async function initializeState() {
  const existing = loadState();
  if (existing) return existing;

  const latest = await latestBuy();
  if (!latest) {
    const state = { lastTimestamp: "0", idsAtTimestamp: [] };
    saveState(state);
    return state;
  }

  const state = { lastTimestamp: String(latest.timestamp), idsAtTimestamp: [latest.id] };
  if (config.replayLatest) {
    state.idsAtTimestamp = [];
    await processBuy(state, latest);
  } else {
    saveState(state);
    log("Initialized at the newest buy; historical trades will not be posted.");
  }
  return state;
}

function startWebServer(holderVerification) {
  if (!process.env.PORT) return;
  const server = http.createServer(async (request, response) => {
    try {
      await holderVerification.handle(request, response);
    } catch (error) {
      log(`Web request failed: ${error.message}`);
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      if (!response.writableEnded) response.end(JSON.stringify({ error: "Internal server error." }));
    }
  });
  server.listen(Number(process.env.PORT), "0.0.0.0", () => log(`Health server listening on port ${process.env.PORT}.`));
}

async function main() {
  log(`Watching $${config.tokenSymbol} buys of ${formatUsd(config.minBuyUsd)} or more.`);
  const holderVerification = createHolderVerification({
    tokenAddress: config.tokenAddress,
    tokenSymbol: config.tokenSymbol,
    log,
  });
  startWebServer(holderVerification);
  await holderVerification.start();
  const state = await initializeState();

  if (config.runOnce) return;

  let delay = config.pollMs;
  while (true) {
    try {
      const buys = await buysSince(state.lastTimestamp);
      for (const buy of buys) await processBuy(state, buy);
      delay = config.pollMs;
    } catch (error) {
      log(`Poll failed: ${error.message}`);
      delay = Math.min(Math.max(delay * 2, 5_000), 60_000);
    }
    await sleep(delay);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
