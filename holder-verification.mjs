import crypto from "node:crypto";
import fs from "node:fs";

const DISCORD_API = "https://discord.com/api/v10";
const DEFAULT_RPC = "https://rpc-gel.inkonchain.com";
const SESSION_LIFETIME_MS = 15 * 60 * 1000;
const CHALLENGE_LIFETIME_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

const DEFAULT_TIERS = [
  { name: "GLUMBO Holder", minimum: "1", color: 0x8b5cf6 },
  { name: "GLUMBO 100K Club", minimum: "100000", color: 0xa855f7 },
  { name: "GLUMBO 1M Club", minimum: "1000000", color: 0xc084fc },
  { name: "GLUMBO Whale", minimum: "10000000", color: 0x22c55e },
];

export function createHolderVerification({ tokenAddress, tokenSymbol, log }) {
  const config = {
    applicationId: process.env.DISCORD_APPLICATION_ID || "",
    botToken: process.env.DISCORD_BOT_TOKEN || "",
    publicKey: process.env.DISCORD_PUBLIC_KEY || "",
    guildId: process.env.DISCORD_GUILD_ID || "",
    publicUrl: (process.env.PUBLIC_URL || "").replace(/\/$/, ""),
    sessionSecret: process.env.SESSION_SECRET || "",
    rpcUrl: process.env.INK_RPC_URL || DEFAULT_RPC,
    databaseFile: process.env.VERIFY_DB_FILE || "./verifications.json",
    refreshMs: numberSetting("ROLE_REFRESH_MS", 6 * 60 * 60 * 1000, 60_000),
    tiers: parseTiers(process.env.ROLE_TIERS_JSON),
  };

  const required = [
    ["DISCORD_APPLICATION_ID", config.applicationId],
    ["DISCORD_BOT_TOKEN", config.botToken],
    ["DISCORD_PUBLIC_KEY", config.publicKey],
    ["DISCORD_GUILD_ID", config.guildId],
    ["PUBLIC_URL", config.publicUrl],
    ["SESSION_SECRET", config.sessionSecret],
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  const enabled = missing.length === 0;
  const challenges = new Map();
  const rateLimits = new Map();
  let tokenDecimals;
  let discordPublicKey;
  let database = loadDatabase(config.databaseFile, log);

  if (config.sessionSecret && config.sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters.");
  }
  if (config.publicKey) discordPublicKey = makeDiscordPublicKey(config.publicKey);

  async function start() {
    if (!enabled) {
      log(`Holder verification disabled; missing ${missing.join(", ")}.`);
      return;
    }
    await registerCommands();
    log("Holder verification enabled with /verify, /holder-status and /unverify.");
    setTimeout(() => refreshAll().catch((error) => log(`Role refresh failed: ${error.message}`)), 60_000).unref();
    setInterval(() => refreshAll().catch((error) => log(`Role refresh failed: ${error.message}`)), config.refreshMs).unref();
  }

  async function handle(request, response) {
    const requestUrl = new URL(request.url, config.publicUrl || "http://localhost");

    if (request.method === "GET" && (requestUrl.pathname === "/" || requestUrl.pathname === "/health")) {
      return sendJson(response, 200, { ok: true, token: tokenSymbol, holderVerification: enabled });
    }

    if (request.method === "POST" && requestUrl.pathname === "/discord/interactions") {
      const body = await readBody(request);
      if (!enabled || !verifyDiscordRequest(request, body)) {
        return sendJson(response, 401, { error: "Invalid Discord request." });
      }
      return handleDiscordInteraction(response, JSON.parse(body.toString("utf8")));
    }

    if (request.method === "GET" && requestUrl.pathname === "/verify") {
      const session = requestUrl.searchParams.get("session") || "";
      if (!enabled || !readSession(session)) return sendHtml(response, 400, errorPage("This verification link is invalid or expired."));
      return sendHtml(response, 200, verificationPage({ session, tokenSymbol }));
    }

    if (requestUrl.pathname.startsWith("/api/")) {
      if (!allowRequest(request)) return sendJson(response, 429, { error: "Too many attempts. Wait one minute and try again." });
      if (request.method === "POST" && requestUrl.pathname === "/api/challenge") {
        return createChallenge(response, JSON.parse((await readBody(request)).toString("utf8")));
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/verify") {
        return completeVerification(response, JSON.parse((await readBody(request)).toString("utf8")));
      }
    }

    return sendJson(response, 404, { error: "Not found." });
  }

  function verifyDiscordRequest(request, body) {
    try {
      const signature = request.headers["x-signature-ed25519"];
      const timestamp = request.headers["x-signature-timestamp"];
      if (!signature || !timestamp || !/^[0-9a-f]{128}$/i.test(signature)) return false;
      return crypto.verify(
        null,
        Buffer.concat([Buffer.from(timestamp), body]),
        discordPublicKey,
        Buffer.from(signature, "hex"),
      );
    } catch {
      return false;
    }
  }

  async function handleDiscordInteraction(response, interaction) {
    if (interaction.type === 1) return sendJson(response, 200, { type: 1 });
    if (interaction.type !== 2 || !interaction.member?.user?.id || !interaction.guild_id) {
      return interactionReply(response, "Run this command inside the GLUMBO Discord server.");
    }

    const userId = interaction.member.user.id;
    const guildId = interaction.guild_id;
    if (guildId !== config.guildId) return interactionReply(response, "This verifier is not configured for this server.");

    if (interaction.data.name === "verify") {
      const session = makeSession({ userId, guildId, exp: Date.now() + SESSION_LIFETIME_MS });
      return sendJson(response, 200, {
        type: 4,
        data: {
          flags: 64,
          embeds: [{
            title: "Verify your GLUMBO holdings",
            description: "Connect the wallet holding GLUMBO and sign the free verification message. This never requests a transaction, payment, approval, private key or seed phrase.",
            color: 0x8b5cf6,
          }],
          components: [{
            type: 1,
            components: [{ type: 2, style: 5, label: "Connect wallet & verify", url: `${config.publicUrl}/verify?session=${encodeURIComponent(session)}` }],
          }],
        },
      });
    }

    if (interaction.data.name === "holder-status") {
      const record = database.users[userId];
      if (!record) return interactionReply(response, "You have not verified a wallet yet. Use `/verify`.");
      return interactionReply(
        response,
        `Verified wallet: \`${shortAddress(record.address)}\`\nLast balance: **${formatUnits(BigInt(record.balanceRaw), record.decimals)} ${tokenSymbol}**\nRoles: ${record.roles.length ? record.roles.join(", ") : "None"}\nLast checked: <t:${Math.floor(new Date(record.checkedAt).getTime() / 1000)}:R>`,
      );
    }

    if (interaction.data.name === "unverify") {
      const record = database.users[userId];
      if (!record) return interactionReply(response, "You do not have a verified wallet connected.");
      sendJson(response, 200, { type: 5, data: { flags: 64 } });
      void performUnverify(interaction.token, guildId, userId);
      return true;
    }

    return interactionReply(response, "Unknown command.");
  }

  async function performUnverify(interactionToken, guildId, userId) {
    let content;
    try {
      await removeManagedRoles(guildId, userId);
      delete database.users[userId];
      saveDatabase(config.databaseFile, database);
      content = "Your wallet connection and GLUMBO holder roles have been removed.";
    } catch (error) {
      log(`Unverify failed for Discord user ${userId}: ${error.message}`);
      content = "I could not remove your roles. Please ask a moderator to check my role permissions.";
    }
    try {
      await editInteraction(interactionToken, content);
    } catch (error) {
      log(`Could not update /unverify response: ${error.message}`);
    }
  }

  async function createChallenge(response, input) {
    const sessionData = readSession(input.session || "");
    const address = normalizeAddress(input.address);
    if (!sessionData || !address) return sendJson(response, 400, { error: "Invalid or expired verification request." });

    cleanupChallenges();
    const challengeId = crypto.randomUUID();
    const nonce = crypto.randomBytes(18).toString("hex");
    const issuedAt = new Date().toISOString();
    const message = [
      "GLUMBO Discord Holder Verification",
      "",
      `Discord user: ${sessionData.userId}`,
      `Wallet: ${address}`,
      `Domain: ${new URL(config.publicUrl).host}`,
      "Ink chain ID: 57073",
      `Nonce: ${nonce}`,
      `Issued at: ${issuedAt}`,
      "",
      "This signature proves wallet ownership only. It does not authorize a transaction, payment, token approval or transfer.",
    ].join("\n");

    challenges.set(challengeId, {
      challengeId,
      address,
      message,
      userId: sessionData.userId,
      guildId: sessionData.guildId,
      expiresAt: Date.now() + CHALLENGE_LIFETIME_MS,
      used: false,
    });
    return sendJson(response, 200, { challengeId, message });
  }

  async function completeVerification(response, input) {
    try {
      const sessionData = readSession(input.session || "");
      const address = normalizeAddress(input.address);
      const challenge = challenges.get(input.challengeId);
      if (!sessionData || !address || !challenge || challenge.used || challenge.expiresAt < Date.now()) {
        return sendJson(response, 400, { error: "This verification request expired. Run /verify again." });
      }
      if (challenge.address !== address || challenge.userId !== sessionData.userId || challenge.guildId !== sessionData.guildId) {
        return sendJson(response, 400, { error: "Verification details do not match." });
      }
      challenge.used = true;

      const valid = await verifyWalletSignature(address, challenge.message, input.signature || "");
      if (!valid) return sendJson(response, 401, { error: "The wallet signature could not be verified." });

      const result = await syncMember(sessionData.guildId, sessionData.userId, address);
      database.users[sessionData.userId] = {
        address,
        balanceRaw: result.balanceRaw.toString(),
        decimals: result.decimals,
        roles: result.roleNames,
        checkedAt: new Date().toISOString(),
      };
      saveDatabase(config.databaseFile, database);

      return sendJson(response, 200, {
        ok: true,
        balance: formatUnits(result.balanceRaw, result.decimals),
        symbol: tokenSymbol,
        roles: result.roleNames,
        message: result.roleNames.length
          ? `Verified. Your Discord roles are: ${result.roleNames.join(", ")}.`
          : `Wallet verified, but it currently holds less than ${config.tiers[0].minimum} ${tokenSymbol}.`,
      });
    } catch (error) {
      log(`Wallet verification failed: ${error.message}`);
      return sendJson(response, 500, { error: "Verification failed. Check the wallet network and try again, or contact a moderator." });
    }
  }

  async function verifyWalletSignature(address, message, signature) {
    if (!/^0x(?:[0-9a-f]{2})+$/i.test(signature)) return false;
    const prefix = `\x19Ethereum Signed Message:\n${Buffer.byteLength(message, "utf8")}`;
    const encodedMessage = `0x${Buffer.concat([Buffer.from(prefix), Buffer.from(message)]).toString("hex")}`;
    const messageHash = `0x${keccak256(Buffer.from(encodedMessage.slice(2), "hex")).toString("hex")}`;
    const code = await rpc("eth_getCode", [address, "latest"]);

    if (code && code !== "0x" && code !== "0x0") {
      const signatureBytes = signature.slice(2);
      const padding = "0".repeat((64 - (signatureBytes.length % 64)) % 64);
      const data = [
        "0x1626ba7e",
        messageHash.slice(2).padStart(64, "0"),
        BigInt(64).toString(16).padStart(64, "0"),
        BigInt(signatureBytes.length / 2).toString(16).padStart(64, "0"),
        signatureBytes,
        padding,
      ].join("");
      const result = await rpc("eth_call", [{ to: address, data }, "latest"]);
      return result.toLowerCase().startsWith("0x1626ba7e");
    }

    if (!/^0x[0-9a-f]{130}$/i.test(signature)) return false;
    const bytes = signature.slice(2);
    const r = bytes.slice(0, 64);
    const s = bytes.slice(64, 128);
    let v = Number.parseInt(bytes.slice(128, 130), 16);
    if (v < 27) v += 27;
    if (v !== 27 && v !== 28) return false;
    const input = `0x${messageHash.slice(2)}${BigInt(v).toString(16).padStart(64, "0")}${r}${s}`;
    const recovered = await rpc("eth_call", [{ to: "0x0000000000000000000000000000000000000001", data: input }, "latest"]);
    return recovered.length >= 42 && `0x${recovered.slice(-40)}`.toLowerCase() === address;
  }

  async function syncMember(guildId, userId, address) {
    const decimals = await getTokenDecimals();
    const balanceRaw = await getTokenBalance(address);
    const tiers = config.tiers.map((tier) => ({ ...tier, minimumRaw: decimalToUnits(tier.minimum, decimals) }));
    const roles = await ensureRoles(guildId, tiers);
    const qualifying = roles.filter((role) => balanceRaw >= role.minimumRaw);
    const desired = qualifying.length
      ? [...new Map([qualifying[0], qualifying[qualifying.length - 1]].map((role) => [role.id, role])).values()]
      : [];

    const member = await discord(`/guilds/${guildId}/members/${userId}`);
    const managedIds = new Set(roles.map((role) => role.id));
    const desiredIds = new Set(desired.map((role) => role.id));

    for (const roleId of member.roles.filter((roleId) => managedIds.has(roleId) && !desiredIds.has(roleId))) {
      await discord(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, { method: "DELETE" });
    }
    for (const roleId of desiredIds) {
      if (!member.roles.includes(roleId)) {
        await discord(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, { method: "PUT" });
      }
    }
    return { balanceRaw, decimals, roleNames: desired.map((role) => role.name) };
  }

  async function removeManagedRoles(guildId, userId) {
    const roles = await ensureRoles(guildId, config.tiers.map((tier) => ({ ...tier, minimumRaw: 0n })));
    const member = await discord(`/guilds/${guildId}/members/${userId}`);
    for (const role of roles) {
      if (member.roles.includes(role.id)) {
        await discord(`/guilds/${guildId}/members/${userId}/roles/${role.id}`, { method: "DELETE" });
      }
    }
  }

  async function ensureRoles(guildId, tiers) {
    let guildRoles = await discord(`/guilds/${guildId}/roles`);
    const resolved = [];
    for (const tier of tiers) {
      let role = guildRoles.find((candidate) => candidate.name === tier.name);
      if (!role) {
        role = await discord(`/guilds/${guildId}/roles`, {
          method: "POST",
          body: { name: tier.name, color: tier.color, hoist: false, mentionable: false },
        });
        guildRoles = [...guildRoles, role];
        log(`Created Discord role ${tier.name}.`);
      }
      resolved.push({ ...tier, id: role.id });
    }
    return resolved;
  }

  async function getTokenDecimals() {
    if (tokenDecimals !== undefined) return tokenDecimals;
    tokenDecimals = Number(BigInt(await rpc("eth_call", [{ to: tokenAddress, data: "0x313ce567" }, "latest"])));
    if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) throw new Error("Invalid token decimals.");
    return tokenDecimals;
  }

  async function getTokenBalance(address) {
    const data = `0x70a08231${address.slice(2).padStart(64, "0")}`;
    return BigInt(await rpc("eth_call", [{ to: tokenAddress, data }, "latest"]));
  }

  async function rpc(method, params) {
    const response = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Ink RPC returned HTTP ${response.status}.`);
    const body = await response.json();
    if (body.error) throw new Error(`Ink RPC error: ${body.error.message}`);
    return body.result;
  }

  async function discord(path, { method = "GET", body } = {}) {
    const response = await fetch(`${DISCORD_API}${path}`, {
      method,
      headers: {
        authorization: `Bot ${config.botToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 204) return null;
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Discord API ${response.status}: ${result.message || "request failed"}`);
    return result;
  }

  async function editInteraction(interactionToken, content) {
    const response = await fetch(`${DISCORD_API}/webhooks/${config.applicationId}/${interactionToken}/messages/@original`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Discord interaction update returned HTTP ${response.status}.`);
  }

  async function registerCommands() {
    const commands = [
      { name: "verify", description: `Verify your ${tokenSymbol} wallet and receive holder roles` },
      { name: "holder-status", description: `View your verified wallet and ${tokenSymbol} roles` },
      { name: "unverify", description: "Disconnect your wallet and remove holder roles" },
    ];
    for (const command of commands) {
      await discord(`/applications/${config.applicationId}/guilds/${config.guildId}/commands`, { method: "POST", body: command });
    }
  }

  async function refreshAll() {
    if (!enabled) return;
    const entries = Object.entries(database.users);
    if (!entries.length) return;
    log(`Refreshing GLUMBO roles for ${entries.length} verified member(s).`);
    for (const [userId, record] of entries) {
      try {
        const result = await syncMember(config.guildId, userId, record.address);
        database.users[userId] = {
          ...record,
          balanceRaw: result.balanceRaw.toString(),
          decimals: result.decimals,
          roles: result.roleNames,
          checkedAt: new Date().toISOString(),
        };
        saveDatabase(config.databaseFile, database);
      } catch (error) {
        log(`Could not refresh Discord user ${userId}: ${error.message}`);
      }
    }
  }

  function makeSession(payload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = crypto.createHmac("sha256", config.sessionSecret).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  function readSession(token) {
    try {
      const [encoded, supplied] = token.split(".");
      if (!encoded || !supplied) return null;
      const expected = crypto.createHmac("sha256", config.sessionSecret).update(encoded).digest();
      const suppliedBytes = Buffer.from(supplied, "base64url");
      if (expected.length !== suppliedBytes.length || !crypto.timingSafeEqual(expected, suppliedBytes)) return null;
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      if (payload.exp < Date.now() || payload.guildId !== config.guildId || !/^\d+$/.test(payload.userId)) return null;
      return payload;
    } catch {
      return null;
    }
  }

  function allowRequest(request) {
    const key = String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown").split(",")[0].trim();
    const now = Date.now();
    const recent = (rateLimits.get(key) || []).filter((time) => now - time < 60_000);
    recent.push(now);
    rateLimits.set(key, recent);
    return recent.length <= 20;
  }

  function cleanupChallenges() {
    const now = Date.now();
    for (const [id, challenge] of challenges) if (challenge.expiresAt < now || challenge.used) challenges.delete(id);
  }

  return { enabled, handle, start };
}

function makeDiscordPublicKey(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("DISCORD_PUBLIC_KEY must be 64 hexadecimal characters.");
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  return crypto.createPublicKey({ key: Buffer.concat([prefix, Buffer.from(hex, "hex")]), format: "der", type: "spki" });
}

function parseTiers(raw) {
  const source = raw ? JSON.parse(raw) : DEFAULT_TIERS;
  if (!Array.isArray(source) || !source.length) throw new Error("ROLE_TIERS_JSON must be a non-empty JSON array.");
  const tiers = source.map((tier) => ({
    name: String(tier.name || "").trim(),
    minimum: String(tier.minimum || "").trim(),
    color: Number(tier.color ?? 0x8b5cf6),
  }));
  for (const tier of tiers) {
    if (!tier.name || tier.name.length > 100 || !/^\d+(\.\d+)?$/.test(tier.minimum)) throw new Error("Invalid role tier configuration.");
  }
  return tiers.sort((a, b) => Number(a.minimum) - Number(b.minimum));
}

function numberSetting(name, fallback, minimum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} must be at least ${minimum}.`);
  return value;
}

function decimalToUnits(value, decimals) {
  const [whole, fraction = ""] = String(value).split(".");
  if (fraction.length > decimals) throw new Error(`Role threshold ${value} has too many decimal places.`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
}

function formatUnits(value, decimals) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = absolute / base;
  const fraction = (absolute % base).toString().padStart(decimals, "0").slice(0, 4).replace(/0+$/, "");
  const number = `${negative ? "-" : ""}${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
  return number;
}

function normalizeAddress(value) {
  const address = String(value || "").toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(address) ? address : null;
}

function shortAddress(address) {
  return `${address.slice(0, 6)}â¦${address.slice(-4)}`;
}

function loadDatabase(file, log) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed.users || typeof parsed.users !== "object") throw new Error("Invalid verification database.");
    return parsed;
  } catch (error) {
    if (error.code !== "ENOENT") log(`Starting with an empty verification database: ${error.message}`);
    return { users: {} };
  }
}

function saveDatabase(file, database) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(database, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function interactionReply(response, content) {
  return sendJson(response, 200, { type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
}

function sendJson(response, status, data) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(data));
  return true;
}

function sendHtml(response, status, html) {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  });
  response.end(html);
  return true;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function errorPage(message) {
  return `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GLUMBO Verification</title><style>${pageCss()}</style><main><div class="mark">G</div><h1>Verification unavailable</h1><p>${escapeHtml(message)}</p></main></html>`;
}

function verificationPage({ session, tokenSymbol }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>${escapeHtml(tokenSymbol)} Holder Verification</title>
  <style>${pageCss()}</style>
</head>
<body>
  <main>
    <div class="mark">G</div>
    <div class="eyebrow">INK HOLDER ACCESS</div>
    <h1>Verify your ${escapeHtml(tokenSymbol)}</h1>
    <p>Connect the wallet holding ${escapeHtml(tokenSymbol)} and sign a free message to receive your Discord role.</p>
    <div class="safe"><strong>Safe verification</strong><br>No transaction. No gas. No token approval. We will never request your private key or seed phrase.</div>
    <button id="verify">Connect wallet</button>
    <a id="metamask" class="secondary hidden" rel="noreferrer">Open in MetaMask</a>
    <div id="status" role="status"></div>
  </main>
  <script>
    const session = ${JSON.stringify(session)};
    const button = document.getElementById('verify');
    const status = document.getElementById('status');
    const metamask = document.getElementById('metamask');
    const setStatus = (text, kind = '') => { status.textContent = text; status.className = kind; };
    const post = async (path, body) => {
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Request failed.');
      return data;
    };
    const walletLink = 'https://metamask.app.link/dapp/' + location.host + location.pathname + location.search;
    metamask.href = walletLink;
    if (!window.ethereum) {
      button.textContent = 'Wallet browser required';
      metamask.classList.remove('hidden');
      setStatus('On mobile, open this page inside MetaMask or another wallet browser.');
    }
    button.addEventListener('click', async () => {
      if (!window.ethereum) return;
      button.disabled = true;
      try {
        setStatus('Connecting walletâ¦');
        const [address] = await window.ethereum.request({ method: 'eth_requestAccounts' });
        try {
          await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xdef1' }] });
        } catch (error) {
          if (error.code !== 4902) throw error;
          await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{
            chainId: '0xdef1', chainName: 'Ink', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://rpc-gel.inkonchain.com'], blockExplorerUrls: ['https://explorer.inkonchain.com']
          }] });
        }
        setStatus('Requesting a free signatureâ¦');
        const challenge = await post('/api/challenge', { session, address });
        const signature = await window.ethereum.request({ method: 'personal_sign', params: [challenge.message, address] });
        setStatus('Checking your GLUMBO balanceâ¦');
        const result = await post('/api/verify', { session, address, signature, challengeId: challenge.challengeId });
        setStatus(result.message + ' Balance: ' + result.balance + ' ' + result.symbol + '.', 'success');
        button.textContent = 'Verified';
      } catch (error) {
        setStatus(error?.message || 'Verification was cancelled or failed.', 'error');
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function pageCss() {
  return `:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;background:#08070d;color:#f7f2ff}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 50% 0,#321655 0,transparent 42%),#08070d}main{width:min(100%,460px);padding:34px 26px;border:1px solid #352548;border-radius:28px;background:rgba(18,13,27,.94);box-shadow:0 26px 80px #000;text-align:center}.mark{width:66px;height:66px;margin:0 auto 22px;border-radius:22px;display:grid;place-items:center;background:#8b5cf6;color:#fff;font-weight:900;font-size:32px;box-shadow:0 0 34px #8b5cf677}.eyebrow{font-size:12px;letter-spacing:.2em;color:#b79adb;font-weight:800}h1{font-size:31px;margin:10px 0 12px}p{color:#c9bfd4;line-height:1.55;margin:0 0 20px}.safe{background:#151021;border:1px solid #3d2c52;border-radius:16px;padding:15px;color:#bbb0c9;font-size:14px;line-height:1.45;margin-bottom:20px}.safe strong{color:#86efac}button,.secondary{width:100%;display:block;border:0;border-radius:14px;padding:16px;font:inherit;font-weight:800;text-decoration:none;cursor:pointer}button{background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:#fff}button:disabled{opacity:.65}.secondary{margin-top:12px;background:#20172d;color:#dbc9f6;border:1px solid #46335e}.hidden{display:none!important}#status{min-height:24px;margin-top:18px;color:#b8adc5;line-height:1.45}.success{color:#86efac!important}.error{color:#fda4af!important}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

// Ethereum uses Keccak-256, which is different from the standardized SHA3-256
// exposed by Node. Keeping this small implementation local avoids a package or
// provider-specific RPC dependency in the verification path.
export function keccak256(input) {
  const rate = 136;
  const lengthWithPadding = Math.ceil((input.length + 2) / rate) * rate;
  const padded = Buffer.alloc(lengthWithPadding);
  input.copy(padded);
  padded[input.length] = 0x01;
  padded[lengthWithPadding - 1] |= 0x80;

  const state = Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane += 1) {
      let value = 0n;
      for (let byte = 0; byte < 8; byte += 1) {
        value |= BigInt(padded[offset + lane * 8 + byte]) << BigInt(byte * 8);
      }
      state[lane] ^= value;
    }
    keccakPermutation(state);
  }

  const output = Buffer.alloc(32);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number((state[Math.floor(index / 8)] >> BigInt((index % 8) * 8)) & 0xffn);
  }
  return output;
}

function keccakPermutation(state) {
  const mask = (1n << 64n) - 1n;
  const rotations = [
    0, 1, 62, 28, 27,
    36, 44, 6, 55, 20,
    3, 10, 43, 25, 39,
    41, 45, 15, 21, 8,
    18, 2, 61, 56, 14,
  ];
  const roundConstants = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
  ];
  const rotate = (value, shift) => {
    if (shift === 0) return value & mask;
    const amount = BigInt(shift);
    return ((value << amount) | (value >> (64n - amount))) & mask;
  };

  for (const roundConstant of roundConstants) {
    const columns = Array(5).fill(0n);
    const offsets = Array(5).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) columns[x] ^= state[x + 5 * y];
    }
    for (let x = 0; x < 5; x += 1) offsets[x] = columns[(x + 4) % 5] ^ rotate(columns[(x + 1) % 5], 1);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) state[x + 5 * y] = (state[x + 5 * y] ^ offsets[x]) & mask;
    }

    const moved = Array(25).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) moved[y + 5 * ((2 * x + 3 * y) % 5)] = rotate(state[x + 5 * y], rotations[x + 5 * y]);
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        state[x + 5 * y] = (moved[x + 5 * y] ^ ((~moved[((x + 1) % 5) + 5 * y]) & moved[((x + 2) % 5) + 5 * y])) & mask;
      }
    }
    state[0] ^= roundConstant;
  }
}
