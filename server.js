/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleAuth } from 'google-auth-library';
import fetch from 'node-fetch';
import rateLimit from 'express-rate-limit';
import { WebSocketServer, WebSocket } from 'ws';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// --- E-Commerce Imports ---
import './database.js'; // Connection & Seeding
import { dbQuery, dbRun, dbGet } from './database.js';
import { authenticateToken, requireSuperAdmin, requireAdminOrSuper, generateToken, JWT_SECRET } from './auth.js';
import { createRazorpayOrder, verifyRazorpaySignature, getRazorpayKey } from './razorpay.js';
import { createShiprocketShipment, getShiprocketTracking } from './shiprocket.js';

const app = express();
app.use(express.json({limit: process?.env?.API_PAYLOAD_MAX_SIZE || "7mb"}));

// Premium Global CORS Middleware (zero-dependency integration)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-App-Proxy');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Secure in-memory caches for security & performance
const otpStore = {}; // Key: email/phone, Value: { code, expiresAt }
const loginAttempts = {}; // Key: email, Value: { count, lockUntil }

// High-Fidelity sendEmailNotification using SendGrid REST API (fetch-based, zero external dependencies)
async function sendEmailNotification(to, subject, htmlContent) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_SENDER_EMAIL || 'verified_sender_email@gurupadukam.com';

  if (!apiKey) {
    console.log(`[Email Service Mock] Dispatching to ${to} | Subject: ${subject}`);
    return false;
  }

  try {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: fromEmail, name: "Gurupadukam Board" },
        subject: subject,
        content: [{ type: 'text/html', value: htmlContent }]
      })
    });
    if (response.ok) {
      console.log(`[Email Service] Real email sent successfully to ${to} via SendGrid.`);
      return true;
    } else {
      const errText = await response.text();
      console.error(`[Email Service Error] SendGrid failed:`, errText);
      return false;
    }
  } catch (err) {
    console.error(`[Email Service Connection Error]:`, err.message);
    return false;
  }
}

// High-Fidelity sendSMSNotification using Twilio REST API (fetch-based, zero external dependencies)
async function sendSMSNotification(to, bodyText) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromPhone = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromPhone) {
    console.log(`[SMS Service Mock] Dispatching SMS to ${to} | Body: ${bodyText}`);
    return false;
  }

  try {
    let formattedTo = to.trim();
    if (!formattedTo.startsWith('+')) {
      if (formattedTo.length === 10) {
        formattedTo = `+91${formattedTo}`;
      } else {
        formattedTo = `+${formattedTo}`;
      }
    }

    const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const params = new URLSearchParams();
    params.append('To', formattedTo);
    params.append('From', fromPhone);
    params.append('Body', bodyText);

    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`
      },
      body: params.toString()
    });

    if (response.ok) {
      console.log(`[SMS Service] Real SMS sent successfully to ${to} via Twilio.`);
      return true;
    } else {
      const errText = await response.text();
      console.error(`[SMS Service Error] Twilio failed:`, errText);
      return false;
    }
  } catch (err) {
    console.error(`[SMS Service Connection Error]:`, err.message);
    return false;
  }
}

// Base32 Alphabet and cryptographic helpers for cost-free TOTP verification
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function generateBase32Secret() {
  const bytes = crypto.randomBytes(10);
  let result = '';
  for (let i = 0; i < bytes.length; i++) {
    result += BASE32_ALPHABET[bytes[i] % 32];
  }
  return result;
}

function base32Decode(base32) {
  let clean = base32.replace(/=+$/, '').toUpperCase();
  let length = clean.length;
  let bits = 0;
  let value = 0;
  let index = 0;
  const buffer = Buffer.alloc(Math.floor((length * 5) / 8));

  for (let i = 0; i < length; i++) {
    const val = BASE32_ALPHABET.indexOf(clean[i]);
    if (val === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | val;
    bits += 5;
    if (bits >= 8) {
      if (index < buffer.length) {
        buffer[index++] = (value >>> (bits - 8)) & 255;
      }
      bits -= 8;
    }
  }
  return buffer;
}

function verifyTOTP(secretBase32, token, timeStep = 30) {
  try {
    const key = base32Decode(secretBase32);
    const epoch = Math.floor(Date.now() / 1000);
    const counter = Math.floor(epoch / timeStep);

    for (let i = -1; i <= 1; i++) {
      const checkCounter = counter + i;
      const buffer = Buffer.alloc(8);
      let tmp = checkCounter;
      for (let j = 7; j >= 0; j--) {
        buffer[j] = tmp & 0xff;
        tmp = tmp >> 8;
      }

      const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
      const offset = hmac[hmac.length - 1] & 0xf;
      const code =
        ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);

      const checkToken = (code % 1_000_000).toString().padStart(6, '0');
      if (checkToken === token.trim()) {
        return true;
      }
    }
  } catch (e) {
    console.error('[TOTP Verification Error]:', e.message);
  }
  return false;
}

const PORT = process?.env?.API_BACKEND_PORT || 5000;
const API_BACKEND_HOST = process?.env?.API_BACKEND_HOST || "127.0.0.1";

const GOOGLE_CLOUD_LOCATION = process?.env?.GOOGLE_CLOUD_LOCATION;
const GOOGLE_CLOUD_PROJECT = process?.env?.GOOGLE_CLOUD_PROJECT;

const PROXY_HEADER = process?.env?.PROXY_HEADER;

app.set('trust proxy', 1);

// Standard Rate Limit
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 200, 
    standardHeaders: true, 
    legacyHeaders: false,
    message: { error: 'Too many requests', message: 'Rate limit exceeded, please try again later.' }
});

// Apply rate limiter to general api and proxy paths
app.use('/api/', apiLimiter);

// --- Vertex AI Studio Proxy Config ---
const API_CLIENT_MAP = [
 {
    name: "VertexGenAi:generateContent",
    patternForProxy: "https://aiplatform.googleapis.com/{{version}}/publishers/google/models/{{model}}:generateContent",
    getApiEndpoint: (context, params) => {
      return `https://aiplatform.clients6.google.com/${params['version']}/projects/${context.projectId}/locations/${context.region}/publishers/google/models/${params['model']}:generateContent`;
    },
    isStreaming: false,
    transformFn: null,
  },
 {
    name: "VertexGenAi:predict",
    patternForProxy: "https://aiplatform.googleapis.com/{{version}}/publishers/google/models/{{model}}:predict",
    getApiEndpoint: (context, params) => {
      return `https://aiplatform.clients6.google.com/${params['version']}/projects/${context.projectId}/locations/${context.region}/publishers/google/models/${params['model']}:predict`;
    },
    isStreaming: false,
    transformFn: null,
  },
 {
    name: "VertexGenAi:streamGenerateContent",
    patternForProxy: "https://aiplatform.googleapis.com/{{version}}/publishers/google/models/{{model}}:streamGenerateContent",
    getApiEndpoint: (context, params) => {
      return `https://aiplatform.clients6.google.com/${params['version']}/projects/${context.projectId}/locations/${context.region}/publishers/google/models/${params['model']}:streamGenerateContent`;
    },
    isStreaming: true,
    transformFn: (response) => {
        let normalizedResponse = response.trim();
        while (normalizedResponse.startsWith(',') || normalizedResponse.startsWith('[')) {
          normalizedResponse = normalizedResponse.substring(1).trim();
        }
        while (normalizedResponse.endsWith(',') || normalizedResponse.endsWith(']')) {
          normalizedResponse = normalizedResponse.substring(0, normalizedResponse.length - 1).trim();
        }
        if (!normalizedResponse.length) return {result: null, inProgress: false};
        if (!normalizedResponse.endsWith('}')) return {result: normalizedResponse, inProgress: true};
        try {
          const parsedResponse = JSON.parse(`${normalizedResponse}`);
          const transformedResponse = `data: ${JSON.stringify(parsedResponse)}\n\n`;
          return {result: transformedResponse, inProgress: false};
        } catch (error) {
          throw new Error(`Failed to parse response: ${error}.`);
        }
    },
  },
 {
    name: "ReasoningEngine:query",
    patternForProxy: "https://{{endpoint_location}}-aiplatform.googleapis.com/{{version}}/projects/{{project_id}}/locations/{{location_id}}/reasoningEngines/{{engine_id}}:query",
    getApiEndpoint: (context, params) => {
      return `https://${params['endpoint_location']}-aiplatform.clients6.google.com/v1beta1/projects/${params['project_id']}/locations/${params['location_id']}/reasoningEngines/${params['engine_id']}:query`;
    },
    isStreaming: false,
    transformFn: null,
  },
 {
    name: "ReasoningEngine:streamQuery",
    patternForProxy: "https://{{endpoint_location}}-aiplatform.googleapis.com/{{version}}/projects/{{project_id}}/locations/{{location_id}}/reasoningEngines/{{engine_id}}:streamQuery",
    getApiEndpoint: (context, params) => {
      return `https://${params['endpoint_location']}-aiplatform.clients6.google.com/v1beta1/projects/${params['project_id']}/locations/${params['location_id']}/reasoningEngines/${params['engine_id']}:streamQuery`;
    },
    isStreaming: true,
    transformFn: null,
  },
].map((client) => ({ ...client, patternInfo: parsePattern(client.patternForProxy) }));

const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parsePattern(pattern) {
  const paramRegex = /\{\{(.*?)\}\}/g;
  const params = [];
  const parts = [];
  let lastIndex = 0;
  let match;

  while ((match = paramRegex.exec(pattern)) !== null) {
    params.push(match[1]);
    const literalPart = pattern.substring(lastIndex, match.index);
    parts.push(escapeRegex(literalPart));
    parts.push(`(?<${match[1]}>[^/]+)`);
    lastIndex = paramRegex.lastIndex;
  }
  parts.push(escapeRegex(pattern.substring(lastIndex)));
  const regexString = parts.join('');

  return {regex: new RegExp(`^${regexString}$`), params};
}

function extractParams(patternInfo, url) {
  const match = url.match(patternInfo.regex);
  if (!match) return null;
  const params = {};
  patternInfo.params.forEach((paramName, index) => {
    params[paramName] = match[index + 1];
  });
  return params;
}

async function getAccessToken(res) {
  try {
    const authClient = await auth.getClient();
    const token = await authClient.getAccessToken();
    return token.token;
  } catch (error) {
    console.error('[Node Proxy] Authentication error:', error);
    if (!res) return null;
    if (error.code === 'ERR_GCLOUD_NOT_LOGGED_IN' || (error.message && error.message.includes('Could not load the default credentials'))) {
      res.status(401).json({
        error: 'Authentication Required',
        message: 'Google Cloud Application Default Credentials not found or invalid.',
      });
    } else {
      res.status(500).json({ error: `Authentication failed: ${error.message}` });
    }
    return null;
  }
}

function getRequestHeaders(accessToken) {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'X-Goog-User-Project': GOOGLE_CLOUD_PROJECT,
    'Content-Type': 'application/json',
  };
}

// --- Original Vertex AI Proxy Route ---
app.post('/api-proxy', async (req, res) => {
  if (req.headers['x-app-proxy'] !== PROXY_HEADER) {
    return res.status(403).send('Forbidden: Request must originate from the Vertex App shim.');
  }

  const { originalUrl, method, headers, body } = req.body;
  if (!originalUrl) {
    return res.status(400).send('Bad Request: originalUrl is required.');
  }

  const apiClient = API_CLIENT_MAP.find(p => {
    req.extractedParams = extractParams(p.patternInfo, originalUrl);
    return req.extractedParams !== null;
  });

  if (!apiClient) {
    console.error(`[Node Proxy] No API client handler found for URL: ${originalUrl}`);
    return res.status(404).json({ error: `No proxy handler found for URL: ${originalUrl}` });
  }

  const extractedParams = req.extractedParams;
  try {
    const accessToken = await getAccessToken(res);
    if (!accessToken) return;

    const context = {projectId: GOOGLE_CLOUD_PROJECT, region: GOOGLE_CLOUD_LOCATION};
    const apiUrl = apiClient.getApiEndpoint(context, extractedParams);
    const apiHeaders = getRequestHeaders(accessToken);

    const apiFetchOptions = {
      method: method || 'POST',
      headers: {...apiHeaders, ...headers},
      body: body ? body : undefined,
    };

    const apiResponse = await fetch(apiUrl, apiFetchOptions);

    if (apiClient.isStreaming) {
      res.writeHead(apiResponse.status, {
        'Content-Type': 'text/event-stream',
        'Transfer-Encoding': 'chunked',
        'Connection': 'keep-alive',
      });
      res.flushHeaders();

      if (!apiResponse.body) {
        return res.end(JSON.stringify({ error: 'Streaming response body is null' }));
      }

      const decoder = new TextDecoder();
      let deltaChunk = '';
      apiResponse.body.on('data', (encodedChunk) => {
        if (res.writableEnded) return;
        try {
          if (!apiClient.transformFn) {
            res.write(encodedChunk);
          } else {
            const decodedChunk = decoder.decode(encodedChunk, { stream: true });
            deltaChunk = deltaChunk + decodedChunk;
            const {result, inProgress} = apiClient.transformFn(deltaChunk);
            if (result && !inProgress) {
              deltaChunk = '';
              res.write(new TextEncoder().encode(result));
            }
          }
        } catch (error) {
          console.error(error);
        }
      });

      apiResponse.body.on('end', () => {
        deltaChunk = '';
        res.end();
      });
    } else {
      const data = await apiResponse.json();
      res.status(apiResponse.status).json(data);
    }
  } catch (error) {
    res.status(500).json({ error: error });
  }
});


// ==========================================
// ============= E-COMMERCE API =============
// ==========================================

// --- 1. Authenticaton APIs ---

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, phone, role, location, specialization, fee, image, cottageCategory, cottageAddress, cottageCapacity, otp, emailCode } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Bad Request', message: 'Name, email, and password are required.' });
  }

  try {
    const existing = await dbGet("SELECT * FROM users WHERE email = ?", [email]);
    if (existing) {
      return res.status(400).json({ error: 'Bad Request', message: 'Email address already registered.' });
    }

    if (phone) {
      const existingPhone = await dbGet("SELECT * FROM users WHERE phone = ?", [phone]);
      if (existingPhone) {
        return res.status(400).json({ error: 'Bad Request', message: 'Mobile number already registered.' });
      }
    }

    const targetRole = role || 'user';

    // Devotee registration (role === 'user' or targetRole === 'user') strictly requires phone OTP or email OTP verification
    if (targetRole === 'user') {
      if (emailCode) {
        // Verify via Email OTP (Cost-Free!)
        const record = otpStore[email];
        if (!record || record.code !== emailCode || record.expiresAt < Date.now()) {
          return res.status(400).json({ error: 'Verification Failed', message: 'Invalid or expired Email verification code.' });
        }
        delete otpStore[email];
      } else if (otp) {
        // Verify via Phone SMS OTP
        if (!phone || phone.length < 10) {
          return res.status(400).json({ error: 'Bad Request', message: 'A valid 10-digit mobile number is required for devotee registration.' });
        }
        const record = otpStore[phone];
        if (!record || record.code !== otp || record.expiresAt < Date.now()) {
          return res.status(400).json({ error: 'Verification Failed', message: 'Invalid or expired Phone SMS OTP.' });
        }
        delete otpStore[phone];
      } else {
        return res.status(400).json({ error: 'Bad Request', message: 'Please provide either the Email verification code or the Phone SMS OTP to complete registration.' });
      }
    }

    const userId = 'usr-' + Math.random().toString(36).substr(2, 9);
    const passwordHash = await bcrypt.hash(password, 10);
    
    let targetLocation = null;
    let isBlocked = 0; // Default active for customers

    if (role === 'purohit') {
      targetRole = 'purohit';
      targetLocation = location || 'Hyderabad';
      isBlocked = 1; // Pending Super-Admin approval
      
      // Auto-insert priest record into directory table to keep fully synchronized
      await dbRun(
        `INSERT INTO purohits (id, name, specialization, rating, fee, image, location, bookings_count)
         VALUES (?, ?, ?, 5.0, ?, ?, ?, 0)`,
        [userId, name, specialization || 'Vedic Homams', fee ? Number(fee) : 3500, image || '', targetLocation]
      );
    } else if (role === 'admin') {
      targetRole = 'admin';
      targetLocation = location || 'Hyderabad';
      isBlocked = 1; // Pending Super-Admin approval
    } else if (role === 'cottage_partner') {
      targetRole = 'cottage_partner';
      targetLocation = location || 'Hyderabad';
      isBlocked = 1; // Pending Super-Admin approval
      
      await dbRun(
        `INSERT INTO cottage_partners (id, name, category, address, capacity, image, location)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, name, cottageCategory || 'General Crafts', cottageAddress || '', cottageCapacity || '', image || '', targetLocation]
      );
    }

    const totp_secret = generateBase32Secret();

    await dbRun(
      "INSERT INTO users (id, name, email, password_hash, phone, role, location, totp_secret, is_blocked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [userId, name, email, passwordHash, phone || null, targetRole, targetLocation, totp_secret, isBlocked]
    );

    if (isBlocked === 1) {
      // Dynamic Notification Logger to alert Super-Admin
      const notifId = 'notif-' + Math.random().toString(36).substr(2, 9);
      let roleLabel = targetRole === 'purohit' ? 'Priest' : targetRole === 'admin' ? 'Admin' : 'Cottage Partner';
      await dbRun(
        `INSERT INTO notifications (id, title, \`desc\`, \`read\`) VALUES (?, ?, ?, 0)`,
        [notifId, `New ${roleLabel} Registration Pending`, `Account registered by ${name} (${email}) for the ${targetLocation} hub is pending Super-Admin activation.`]
      );

      return res.status(201).json({
        pendingApproval: true,
        message: `Your registration request as a ${roleLabel} was submitted successfully! Your account will be activated once it is approved by the Super Admin.`
      });
    }

    const token = generateToken({ id: userId, name, email, role: targetRole, location: targetLocation });
    res.status(201).json({ token, user: { id: userId, name, email, role: targetRole, location: targetLocation, is_blocked: 0, totp_secret } });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

function trackFailedAttempt(email) {
  if (!loginAttempts[email]) {
    loginAttempts[email] = { count: 1, lockUntil: null };
  } else {
    loginAttempts[email].count += 1;
    if (loginAttempts[email].count >= 5) {
      loginAttempts[email].lockUntil = Date.now() + 10 * 60 * 1000; // 10 minutes lockout
    }
  }
}

app.post('/api/auth/login', async (req, res) => {
  const { email, password, totp } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Bad Request', message: 'Email and password are required.' });
  }

  // Brute-force Lockout Check
  const attempt = loginAttempts[email];
  if (attempt && attempt.lockUntil && attempt.lockUntil > Date.now()) {
    const waitMin = Math.ceil((attempt.lockUntil - Date.now()) / 60000);
    return res.status(429).json({ 
      error: 'Too Many Requests', 
      message: `Security Lockout: Too many failed login attempts on this account. Please wait ${waitMin} minute(s) before trying again. 🔒` 
    });
  }

  try {
    const user = await dbGet("SELECT * FROM users WHERE email = ?", [email]);
    if (!user) {
      trackFailedAttempt(email);
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid email or password combination.' });
    }

    if (user.is_blocked === 1) {
      const msg = (user.role === 'purohit' || user.role === 'admin')
        ? 'Your registration is currently pending Super-Admin validation. You will be able to access your dashboard as soon as the platform administrator activates your account. ✦'
        : 'Your account has been suspended by the platform administrator.';
      return res.status(403).json({ error: 'Forbidden', message: msg });
    }

    const matches = await bcrypt.compare(password, user.password_hash);
    if (!matches) {
      trackFailedAttempt(email);
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid email or password combination.' });
    }

    // Verify TOTP if enabled on the devotee account
    if (user.totp_secret) {
      if (!totp) {
        return res.status(400).json({ error: 'MFA Required', message: 'Time-based OTP verification code is required for this account. Please enter the code from your Authenticator app. 🔐' });
      }
      const verified = verifyTOTP(user.totp_secret, totp);
      if (!verified) {
        return res.status(401).json({ error: 'MFA Failed', message: 'Invalid or expired Authenticator verification code. Please check your app.' });
      }
    }

    // Reset failed login attempts on successful login
    if (loginAttempts[email]) {
      delete loginAttempts[email];
    }

    const token = generateToken({ id: user.id, name: user.name, email: user.email, role: user.role, location: user.location });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, location: user.location, is_blocked: user.is_blocked } });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// Google Social OAuth Sign-In Endpoint (Zero-Cost authentication)
app.post('/api/auth/google', async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) {
    return res.status(400).json({ error: 'Bad Request', message: 'Google ID Token is required.' });
  }

  try {
    const { OAuth2Client } = await import('google-auth-library');
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
    
    // Fallback sandbox verify if client ID is missing in environment variables (great for developers!)
    if (!process.env.GOOGLE_CLIENT_ID) {
      console.log(`[Google OAuth Mock] Verifying simulated ID Token...`);
      const payload = {
        email: 'devotee.google@gmail.com',
        name: 'Google Devotee',
        sub: 'google-oauth-sub-123456789'
      };
      return handleGooglePayload(payload, res);
    }

    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    return handleGooglePayload(payload, res);
  } catch (err) {
    res.status(400).json({ error: 'Google Auth Failed', message: err.message });
  }
});

async function handleGooglePayload(payload, res) {
  const { email, name, sub: googleId } = payload;
  
  try {
    let user = await dbGet("SELECT * FROM users WHERE email = ?", [email]);
    if (!user) {
      const userId = 'usr-' + Math.random().toString(36).substr(2, 9);
      const randomPassword = await bcrypt.hash(Math.random().toString(36), 10);
      const totp_secret = generateBase32Secret();

      await dbRun(
        "INSERT INTO users (id, name, email, password_hash, role, totp_secret, is_blocked) VALUES (?, ?, ?, ?, 'user', ?, 0)",
        [userId, name, email, randomPassword, totp_secret]
      );
      user = { id: userId, name, email, role: 'user', location: null, is_blocked: 0, totp_secret };
    }

    if (user.is_blocked === 1) {
      return res.status(403).json({ error: 'Forbidden', message: 'Your account has been suspended by the platform administrator.' });
    }

    const token = generateToken({ id: user.id, name: user.name, email: user.email, role: user.role, location: user.location });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, location: user.location, is_blocked: user.is_blocked } });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
}

// Zero-Cost Email OTP Login/Register Endpoint
app.post('/api/auth/email-login/send', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Bad Request', message: 'Valid email address required.' });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore[email] = { code, expiresAt: Date.now() + 5 * 60 * 1000 };

  console.log(`[Email Login Service] Secure code ${code} dispatched to ${email}`);
  
  const subject = `✦ Gurupadukam Email Login Code: ${code} ✦`;
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #C9943A; border-radius: 10px; max-width: 500px; background-color: #FCFBF8; margin: auto;">
      <h2 style="color: #5C0A20; text-align: center; border-bottom: 2px solid #C9943A; padding-bottom: 10px;">gurupadukam.com</h2>
      <p style="font-size: 16px; color: #1A1A1A;">Dear Devotee,</p>
      <p style="font-size: 14px; color: #333; line-height: 1.6;">You requested a zero-cost instant login. Use the 6-digit secure code below to log in or register:</p>
      <div style="font-size: 28px; font-weight: bold; color: #5C0A20; text-align: center; background-color: rgba(201,148,58,0.1); padding: 15px; border-radius: 5px; margin: 20px 0; letter-spacing: 2px;">
        ${code}
      </div>
      <p style="font-size: 12px; color: #666; font-style: italic;">This login code is valid for 5 minutes. Please do not share this code.</p>
      <hr style="border: 0; border-top: 1px solid #eee;" />
      <p style="font-size: 10px; color: #999; text-align: center;">© ${new Date().getFullYear()} gurupadukam.com. All rights reserved.</p>
    </div>
  `;
  
  await sendEmailNotification(email, subject, htmlContent);
  res.json({ message: 'Email login verification code generated and sent successfully.' });
});

app.post('/api/auth/email-login/verify', async (req, res) => {
  const { email, code, name } = req.body;
  if (!email || !code) {
    return res.status(400).json({ error: 'Bad Request', message: 'Email and verification code are required.' });
  }

  const record = otpStore[email];
  if (!record || record.code !== code || record.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'Verification Failed', message: 'Invalid or expired email verification code.' });
  }

  delete otpStore[email];

  try {
    let user = await dbGet("SELECT * FROM users WHERE email = ?", [email]);
    if (!user) {
      const userId = 'usr-' + Math.random().toString(36).substr(2, 9);
      const generatedPass = await bcrypt.hash(Math.random().toString(36), 10);
      const regName = name || 'Devotee';
      const totp_secret = generateBase32Secret();

      await dbRun(
        "INSERT INTO users (id, name, email, password_hash, role, totp_secret, is_blocked) VALUES (?, ?, ?, ?, 'user', ?, 0)",
        [userId, regName, email, generatedPass, totp_secret]
      );
      user = { id: userId, name: regName, email, role: 'user', location: null, is_blocked: 0, totp_secret };
    }

    if (user.is_blocked === 1) {
      return res.status(403).json({ error: 'Forbidden', message: 'Your account has been suspended by the platform administrator.' });
    }

    const token = generateToken({ id: user.id, name: user.name, email: user.email, role: user.role, location: user.location });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, location: user.location, is_blocked: user.is_blocked } });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/auth/otp/send', async (req, res) => {
  const { phone } = req.body;
  if (!phone || phone.length < 10) {
    return res.status(400).json({ error: 'Bad Request', message: 'Valid mobile number required.' });
  }
  
  // Generate secure random 6-digit OTP code with 5-minute expiry
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore[phone] = { code, expiresAt: Date.now() + 5 * 60 * 1000 };

  console.log(`[SMS Service] Secure OTP ${code} dispatched to phone ${phone}`);
  const messageText = code;
  await sendSMSNotification(phone, messageText);

  res.json({ message: 'OTP code generated and sent successfully.' }); 
});

app.post('/api/auth/email-code/send', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Bad Request', message: 'Valid email address required.' });
  }

  // Generate secure random 6-digit email code with 5-minute expiry
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore[email] = { code, expiresAt: Date.now() + 5 * 60 * 1000 };

  console.log(`[Email Service] Secure verification code ${code} dispatched to email ${email}`);
  const subject = `Gurupadukam Verification Code: ${code} ✦`;
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #C9943A; border-radius: 10px; max-width: 500px; background-color: #FCFBF8; margin: auto;">
      <h2 style="color: #5C0A20; text-align: center; border-bottom: 2px solid #C9943A; padding-bottom: 10px;">gurupadukam.com</h2>
      <p style="font-size: 16px; color: #1A1A1A;">Dear Devotee,</p>
      <p style="font-size: 14px; color: #333; line-height: 1.6;">Your secure multi-factor authentication or registration verification code is:</p>
      <div style="font-size: 28px; font-weight: bold; color: #5C0A20; text-align: center; background-color: rgba(201,148,58,0.1); padding: 15px; border-radius: 5px; margin: 20px 0; letter-spacing: 2px;">
        ${code}
      </div>
      <p style="font-size: 12px; color: #666; font-style: italic;">This verification code is valid for 5 minutes. For security, please do not share this code with anyone.</p>
      <hr style="border: 0; border-top: 1px solid #eee;" />
      <p style="font-size: 10px; color: #999; text-align: center;">© ${new Date().getFullYear()} gurupadukam.com. All rights reserved.</p>
    </div>
  `;
  await sendEmailNotification(email, subject, htmlContent);

  res.json({ message: 'Verification code generated and sent successfully.' });
});

// Cost-free TOTP verification endpoint for onboarding validation
app.post('/api/auth/totp/verify', async (req, res) => {
  const { secret, token } = req.body;
  if (!secret || !token) {
    return res.status(400).json({ error: 'Bad Request', message: 'Secret and token are required.' });
  }
  const verified = verifyTOTP(secret, token);
  if (verified) {
    return res.json({ success: true, message: 'Time-based OTP verified successfully. Authenticator is active! 🔐' });
  } else {
    return res.status(400).json({ error: 'Verification Failed', message: 'Invalid 6-digit code. Please verify your app time synchronization.' });
  }
});

app.post('/api/auth/otp/verify', async (req, res) => {
  const { phone, otp, role, name } = req.body;
  if (!phone || !otp) {
    return res.status(400).json({ error: 'Bad Request', message: 'Phone and OTP are required.' });
  }

  // Verify expiring OTP in cache
  const record = otpStore[phone];
  if (!record || record.code !== otp || record.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'Unauthorized', message: 'Invalid or expired OTP code.' });
  }
  
  // Clear OTP once verified
  delete otpStore[phone];

  try {
    let user = await dbGet("SELECT * FROM users WHERE phone = ?", [phone]);
    if (user && user.is_blocked === 1) {
      const msg = (user.role === 'purohit' || user.role === 'admin' || user.role === 'cottage_partner')
        ? 'Your registration is currently pending Super-Admin validation. You will be able to access your dashboard as soon as the platform administrator activates your account. ✦'
        : 'Your account has been suspended by the platform administrator.';
      return res.status(403).json({ error: 'Forbidden', message: msg });
    }

    if (!user) {
      const userId = 'usr-' + Math.random().toString(36).substr(2, 9);
      const generatedPass = await bcrypt.hash(Math.random().toString(36), 10);
      const regName = name || 'Devotee';
      const regEmail = `${phone}@phone.user`;
      const targetRole = role === 'admin' ? 'admin' : 'user';

      await dbRun(
        "INSERT INTO users (id, name, email, password_hash, phone, role, is_blocked) VALUES (?, ?, ?, ?, ?, ?, 0)",
        [userId, regName, regEmail, generatedPass, phone, targetRole]
      );
      user = { id: userId, name: regName, email: regEmail, role: targetRole, location: null, is_blocked: 0 };
    }

    const token = generateToken({ id: user.id, name: user.name, email: user.email, role: user.role, location: user.location });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, location: user.location, is_blocked: user.is_blocked } });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/auth/password-reset', async (req, res) => {
  const { email, phone, emailCode, otp, newPassword } = req.body;

  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'Bad Request', message: 'Password must be at least 8 characters long.' });
  }

  // Password complexity check
  const complexityRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
  if (!complexityRegex.test(newPassword)) {
    return res.status(400).json({ 
      error: 'Bad Request', 
      message: 'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character (@$!%*?&).' 
    });
  }

  try {
    // Find user by either email or phone
    let user = null;
    if (email) {
      user = await dbGet("SELECT * FROM users WHERE email = ?", [email]);
    } else if (phone) {
      user = await dbGet("SELECT * FROM users WHERE phone = ?", [phone]);
    }

    if (!user) {
      return res.status(404).json({ error: 'Not Found', message: 'No registered account matches these coordinates.' });
    }

    const isPrivileged = user.role === 'admin' || user.role === 'super_admin' || user.role === 'purohit';

    if (isPrivileged) {
      // MFA required: MUST verify BOTH email code AND phone OTP!
      if (!email || !phone || !emailCode || !otp) {
        return res.status(400).json({ 
          error: 'MFA Required', 
          message: 'Multi-Factor Authentication (MFA) is strictly required for Admin and Priest accounts. Both Email and Phone verification codes must be provided.' 
        });
      }

      // Verify email code
      const emailRecord = otpStore[email];
      if (!emailRecord || emailRecord.code !== emailCode || emailRecord.expiresAt < Date.now()) {
        return res.status(400).json({ error: 'MFA Failed', message: 'Invalid or expired Email verification code.' });
      }

      // Verify phone OTP
      const phoneRecord = otpStore[phone];
      if (!phoneRecord || phoneRecord.code !== otp || phoneRecord.expiresAt < Date.now()) {
        return res.status(400).json({ error: 'MFA Failed', message: 'Invalid or expired Phone SMS OTP.' });
      }

      // Verify that user matches both coordinates
      if (user.email !== email || user.phone !== phone) {
        return res.status(400).json({ error: 'MFA Failed', message: 'Security conflict: Provided email and phone coordinates do not match this account.' });
      }

      // Clear codes
      delete otpStore[email];
      delete otpStore[phone];

    } else {
      // Devotee (standard user): Verify either email OR phone
      if (email && emailCode) {
        const record = otpStore[email];
        if (!record || record.code !== emailCode || record.expiresAt < Date.now()) {
          return res.status(400).json({ error: 'Verification Failed', message: 'Invalid or expired Email verification code.' });
        }
        delete otpStore[email];
      } else if (phone && otp) {
        const record = otpStore[phone];
        if (!record || record.code !== otp || record.expiresAt < Date.now()) {
          return res.status(400).json({ error: 'Verification Failed', message: 'Invalid or expired Phone SMS OTP.' });
        }
        delete otpStore[phone];
      } else {
        return res.status(400).json({ error: 'Bad Request', message: 'Please provide either Email + code or Phone + OTP for verification.' });
      }
    }

    // Encrypt and update password
    const hashed = await bcrypt.hash(newPassword, 10);
    await dbRun("UPDATE users SET password_hash = ? WHERE id = ?", [hashed, user.id]);

    // Clear failed login lockouts if any
    if (loginAttempts[user.email]) {
      delete loginAttempts[user.email];
    }

    res.json({ message: 'Password reset successfully. You can now log in with your new credentials. ✦' });

  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await dbGet("SELECT id, name, email, phone, role, location, is_blocked FROM users WHERE id = ?", [req.user.id]);
    if (!user) {
      return res.status(404).json({ error: 'Not Found', message: 'User profile not found.' });
    }
    if (user.is_blocked === 1) {
      return res.status(403).json({ error: 'Forbidden', message: 'Your account has been suspended.' });
    }
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});


// --- 2. Products Catalog APIs ---

app.get('/api/products', async (req, res) => {
  try {
    const products = await dbQuery("SELECT * FROM products");
    // Convert is_organic SQLite 0/1 back to Boolean for React components
    const mappedProducts = products.map(p => ({
      ...p,
      isOrganic: p.is_organic === 1,
      originalPrice: p.original_price
    }));
    res.json(mappedProducts);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// Create product (Super Admin directly, Partner Admin submits a proposal)
app.post('/api/products', authenticateToken, requireAdminOrSuper, async (req, res) => {
  const { id, name, nameTe, price, originalPrice, category, image, description, stock, badge, isOrganic } = req.body;

  if (!id || !name || !price) {
    return res.status(400).json({ error: 'Bad Request', message: 'Product ID, Name, and Price are required.' });
  }

  try {
    const details = { id, name, nameTe, price, originalPrice, category, image, description, stock, badge, isOrganic };
    
    if (req.user.role === 'super_admin') {
      // Commit directly
      await dbRun(
        `INSERT INTO products (id, name, name_te, price, original_price, category, image, description, stock, badge, is_organic)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, name, nameTe || null, price, originalPrice || null, category || null, image || null, description || null, stock || 0, badge || null, isOrganic ? 1 : 0]
      );
      return res.status(201).json({ message: 'Product created successfully.', product: details });
    } else {
      // Create proposal queue item
      const proposalId = 'prop-' + Math.random().toString(36).substr(2, 9);
      await dbRun(
        `INSERT INTO proposals (id, proposer_id, proposer_name, proposer_location, action_type, product_id, details)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [proposalId, req.user.id, req.user.name, req.user.location || 'Unknown', 'add_product', id, JSON.stringify(details)]
      );
      // Dynamic Notification Logger
      const notifId = 'notif-' + Math.random().toString(36).substr(2, 9);
      await dbRun(
        `INSERT INTO notifications (id, title, \`desc\`, \`read\`) VALUES (?, ?, ?, 0)`,
        [notifId, `Catalog Proposal from ${req.user.name}`, `Admin proposed adding new product SKU: ${id} (${name}) at the ${req.user.location || 'Unknown'} hub.`]
      );
      return res.status(202).json({ message: 'Request submitted for Super Admin approval.', proposalId });
    }
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// Update product (Super Admin commits directly, Partner Admins create a proposal)
app.put('/api/products/:id', authenticateToken, requireAdminOrSuper, async (req, res) => {
  const productId = req.params.id;
  const { name, nameTe, price, originalPrice, category, image, description, stock, badge, isOrganic, editStockOnly } = req.body;

  try {
    const existing = await dbGet("SELECT * FROM products WHERE id = ?", [productId]);
    if (!existing) {
      return res.status(404).json({ error: 'Not Found', message: 'Product not found.' });
    }

    const proposedDetails = { name, nameTe, price, originalPrice, category, image, description, stock, badge, isOrganic, editStockOnly };
    
    if (req.user.role === 'super_admin') {
      // Commit directly
      if (editStockOnly) {
        await dbRun("UPDATE products SET stock = ? WHERE id = ?", [stock, productId]);
      } else {
        await dbRun(
          `UPDATE products SET name = ?, name_te = ?, price = ?, original_price = ?, category = ?, 
                               image = ?, description = ?, stock = ?, badge = ?, is_organic = ? 
           WHERE id = ?`,
          [name || existing.name, nameTe || existing.name_te, price || existing.price, originalPrice || existing.original_price, 
           category || existing.category, image || existing.image, description || existing.description, stock !== undefined ? stock : existing.stock, 
           badge !== undefined ? badge : existing.badge, isOrganic !== undefined ? (isOrganic ? 1 : 0) : existing.is_organic, productId]
        );
      }
      return res.json({ message: 'Product updated successfully.' });
    } else {
      // Create proposal queue item
      const proposalId = 'prop-' + Math.random().toString(36).substr(2, 9);
      await dbRun(
        `INSERT INTO proposals (id, proposer_id, proposer_name, proposer_location, action_type, product_id, details)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [proposalId, req.user.id, req.user.name, req.user.location || 'Unknown', editStockOnly ? 'edit_stock' : 'edit_product', productId, JSON.stringify(proposedDetails)]
      );
      // Dynamic Notification Logger
      const notifId = 'notif-' + Math.random().toString(36).substr(2, 9);
      await dbRun(
        `INSERT INTO notifications (id, title, \`desc\`, \`read\`) VALUES (?, ?, ?, 0)`,
        [notifId, `${editStockOnly ? 'Stock' : 'Catalog'} Edit Proposal from ${req.user.name}`, `Admin proposed updating product SKU: ${productId} (${existing.name}) at the ${req.user.location || 'Unknown'} hub.`]
      );
      return res.status(202).json({ message: 'Edit request submitted for Super Admin approval.', proposalId });
    }
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// Delete product (Super Admin deletes directly, Location Admin creates a delete proposal)
app.delete('/api/products/:id', authenticateToken, requireAdminOrSuper, async (req, res) => {
  const productId = req.params.id;
  try {
    const existing = await dbGet("SELECT * FROM products WHERE id = ?", [productId]);
    if (!existing) {
      return res.status(404).json({ error: 'Not Found', message: 'Product not found.' });
    }
    
    if (req.user.role === 'super_admin') {
      await dbRun("DELETE FROM products WHERE id = ?", [productId]);
      res.json({ message: 'Product deleted successfully.' });
    } else {
      // Create proposal queue item for delete
      const proposalId = 'prop-' + Math.random().toString(36).substr(2, 9);
      await dbRun(
        `INSERT INTO proposals (id, proposer_id, proposer_name, proposer_location, action_type, product_id, details)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [proposalId, req.user.id, req.user.name, req.user.location || 'Unknown', 'delete_product', productId, JSON.stringify(existing)]
      );
      // Dynamic Notification Logger
      const notifId = 'notif-' + Math.random().toString(36).substr(2, 9);
      await dbRun(
        `INSERT INTO notifications (id, title, \`desc\`, \`read\`) VALUES (?, ?, ?, 0)`,
        [notifId, `Catalog Delete Proposal from ${req.user.name}`, `Admin proposed deleting product SKU: ${productId} (${existing.name}) at the ${req.user.location || 'Unknown'} hub.`]
      );
      return res.status(202).json({ message: 'Delete request submitted for Super Admin approval.', proposalId });
    }
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});


// --- Notifications APIs for Admins ---
app.get('/api/admin/notifications', authenticateToken, requireAdminOrSuper, async (req, res) => {
  try {
    const notifications = await dbQuery("SELECT * FROM notifications ORDER BY created_at DESC");
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.put('/api/admin/notifications/:id/read', authenticateToken, requireAdminOrSuper, async (req, res) => {
  const notificationId = req.params.id;
  try {
    await dbRun("UPDATE notifications SET \`read\` = 1 WHERE id = ?", [notificationId]);
    res.json({ message: 'Notification marked as read successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});


// --- 3. Super Admin Proposal Queue APIs ---

app.get('/api/proposals', authenticateToken, requireAdminOrSuper, async (req, res) => {
  try {
    let proposals;
    if (req.user.role === 'super_admin') {
      proposals = await dbQuery("SELECT * FROM proposals ORDER BY created_at DESC");
    } else {
      proposals = await dbQuery("SELECT * FROM proposals WHERE proposer_id = ? ORDER BY created_at DESC", [req.user.id]);
    }
    
    const mappedProposals = proposals.map(p => ({
      ...p,
      details: JSON.parse(p.details)
    }));
    res.json(mappedProposals);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/proposals/:id/approve', authenticateToken, requireSuperAdmin, async (req, res) => {
  const proposalId = req.params.id;
  try {
    const proposal = await dbGet("SELECT * FROM proposals WHERE id = ?", [proposalId]);
    if (!proposal) {
      return res.status(404).json({ error: 'Not Found', message: 'Proposal not found.' });
    }

    if (proposal.status !== 'pending') {
      return res.status(400).json({ error: 'Bad Request', message: 'Proposal has already been processed.' });
    }

    const details = JSON.parse(proposal.details);

    if (proposal.action_type === 'add_product') {
      await dbRun(
        `INSERT INTO products (id, name, name_te, price, original_price, category, image, description, stock, badge, is_organic)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [details.id, details.name, details.nameTe || null, details.price, details.originalPrice || null, details.category || null, details.image || null, details.description || null, details.stock || 0, details.badge || null, details.isOrganic ? 1 : 0]
      );
    } else if (proposal.action_type === 'add_purohit') {
      await dbRun(
        `INSERT INTO purohits (id, name, specialization, rating, fee, image, location, bookings_count)
         VALUES (?, ?, ?, 5.0, ?, ?, ?, 0)`,
        [details.id, details.name, details.specialization, details.fee || 0, details.image || '', details.location]
      );
    } else if (proposal.action_type === 'edit_stock') {
      await dbRun("UPDATE products SET stock = ? WHERE id = ?", [details.stock, proposal.product_id]);
    } else if (proposal.action_type === 'edit_product') {
      const existing = await dbGet("SELECT * FROM products WHERE id = ?", [proposal.product_id]);
      if (existing) {
        await dbRun(
          `UPDATE products SET name = ?, name_te = ?, price = ?, original_price = ?, category = ?, 
                                image = ?, description = ?, stock = ?, badge = ?, is_organic = ? 
           WHERE id = ?`,
          [details.name || existing.name, details.nameTe || existing.name_te, details.price || existing.price, details.originalPrice || existing.original_price, 
           details.category || existing.category, details.image || existing.image, details.description || existing.description, details.stock !== undefined ? details.stock : existing.stock, 
           details.badge !== undefined ? details.badge : existing.badge, details.isOrganic !== undefined ? (details.isOrganic ? 1 : 0) : existing.is_organic, proposal.product_id]
        );
      }
    } else if (proposal.action_type === 'delete_product') {
      await dbRun("DELETE FROM products WHERE id = ?", [proposal.product_id]);
    }

    await dbRun("UPDATE proposals SET status = 'approved' WHERE id = ?", [proposalId]);
    res.json({ message: 'Proposal approved and committed successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/proposals/:id/reject', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const proposal = await dbGet("SELECT * FROM proposals WHERE id = ? AND status = 'pending'", [req.params.id]);
    if (!proposal) {
      return res.status(404).json({ error: 'Not Found', message: 'Pending proposal not found.' });
    }
    await dbRun("UPDATE proposals SET status = 'rejected' WHERE id = ?", [req.params.id]);
    res.json({ message: 'Proposal rejected successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});


// --- 4. Razorpay Payments Route ---

app.post('/api/payments/razorpay/order', authenticateToken, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Bad Request', message: 'Valid payment amount required.' });
  }

  try {
    const rzpOrder = await createRazorpayOrder(amount);
    res.json({
      key: getRazorpayKey(),
      order_id: rzpOrder.id,
      amount: rzpOrder.amount,
      currency: rzpOrder.currency,
      isMock: rzpOrder.isMock
    });
  } catch (err) {
    res.status(500).json({ error: 'Razorpay Error', message: err.message });
  }
});


// --- 5. E-Commerce Order Placement & Sync APIs ---

app.post('/api/orders', authenticateToken, async (req, res) => {
  const { 
    customerName, 
    customerEmail, 
    customerPhone, 
    shippingAddress, 
    cartItems, 
    total, 
    paymentMethod,
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature 
  } = req.body;

  if (!customerName || !customerEmail || !customerPhone || !shippingAddress || !cartItems || cartItems.length === 0) {
    return res.status(400).json({ error: 'Bad Request', message: 'Complete billing and shipping details required.' });
  }

  // 1. Cryptographic Payment Verification (if Razorpay)
  if (paymentMethod === 'Razorpay') {
    const verified = verifyRazorpaySignature(razorpayOrderId, razorpayPaymentId, razorpaySignature);
    if (!verified) {
      return res.status(400).json({ error: 'Signature Verification Failed', message: 'Transaction signature mismatch.' });
    }
  }

  try {
    // 2. Stock Verification (Transaction Lock Check)
    for (const item of cartItems) {
      const product = await dbGet("SELECT stock, name FROM products WHERE id = ?", [item.id]);
      if (!product) {
        return res.status(400).json({ error: 'Product Error', message: `Product ${item.name} not found in database.` });
      }
      if (product.stock < item.quantity) {
        return res.status(400).json({ error: 'Out of Stock', message: `Insufficient stock for product: ${product.name}. Only ${product.stock} units remaining.` });
      }
    }

    // 3. Insert Order
    const orderId = 'ORD-' + Math.floor(100000 + Math.random() * 900000);
    const paymentStatus = paymentMethod === 'Cash on Delivery' ? 'payment-pending' : 'paid';

    await dbRun(
      `INSERT INTO orders (id, user_id, customer_name, customer_email, customer_phone, shipping_address, total, payment_method, payment_status, razorpay_order_id, razorpay_payment_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderId, req.user.id, customerName, customerEmail, customerPhone, JSON.stringify(shippingAddress), total, paymentMethod, paymentStatus, razorpayOrderId || null, razorpayPaymentId || null]
    );

    // Dynamic Notifications: Log New Order
    const orderNotifId = 'notif-' + Math.random().toString(36).substr(2, 9);
    await dbRun(
      `INSERT INTO notifications (id, title, \`desc\`, \`read\`) VALUES (?, ?, ?, 0)`,
      [orderNotifId, `New Order Received`, `Order ${orderId} placed by ${customerName} for ₹${total} via ${paymentMethod}.`]
    );

    // 4. Insert Order Items & Deduct Inventory Stock Level
    for (const item of cartItems) {
      await dbRun(
        `INSERT INTO order_items (order_id, product_id, product_name, quantity, price)
         VALUES (?, ?, ?, ?, ?)`,
        [orderId, item.id, item.name, item.quantity, item.price]
      );

      // Decrement stock automatically
      await dbRun("UPDATE products SET stock = stock - ? WHERE id = ?", [item.quantity, item.id]);

      // Check for low stock alert
      const productObj = await dbGet("SELECT stock FROM products WHERE id = ?", [item.id]);
      if (productObj && productObj.stock < 10) {
        const stockNotifId = 'notif-' + Math.random().toString(36).substr(2, 9);
        await dbRun(
          `INSERT INTO notifications (id, title, \`desc\`, \`read\`) VALUES (?, ?, ?, 0)`,
          [stockNotifId, `Low Stock Warning: ${item.name}`, `Product SKU ${item.id} has fallen to ${productObj.stock} units at all hubs.`]
        );
      }
    }

    // 5. Automatic Shiprocket Shipment Creation
    const fullOrderData = {
      id: orderId,
      customer_name: customerName,
      customer_email: customerEmail,
      customer_phone: customerPhone,
      shipping_address: JSON.stringify(shippingAddress),
      total,
      payment_method: paymentMethod,
      items: cartItems,
      date: new Date().toISOString()
    };

    const shipment = await createShiprocketShipment(fullOrderData);

    // Map Shiprocket parameters in orders table
    await dbRun(
      `UPDATE orders SET shiprocket_shipment_id = ?, shiprocket_awb = ? WHERE id = ?`,
      [shipment.shipment_id, shipment.awb_code, orderId]
    );

    const completeOrder = {
      id: orderId,
      userId: req.user.id,
      customerName,
      customerEmail,
      customerPhone,
      shippingAddress,
      items: cartItems,
      total,
      paymentMethod,
      paymentStatus,
      shiprocketShipmentId: shipment.shipment_id,
      shiprocketAwb: shipment.awb_code,
      status: 'Processing',
      date: new Date().toISOString()
    };

    res.status(201).json({ message: 'Order completed and inventory deducted.', order: completeOrder });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.get('/api/orders/my', authenticateToken, async (req, res) => {
  try {
    const orders = await dbQuery("SELECT * FROM orders WHERE user_id = ? ORDER BY date DESC", [req.user.id]);
    const mappedOrders = [];

    for (const order of orders) {
      const items = await dbQuery("SELECT * FROM order_items WHERE order_id = ?", [order.id]);
      
      const mappedItems = items.map(i => ({
        id: i.product_id,
        name: i.product_name,
        quantity: i.quantity,
        price: i.price
      }));

      mappedOrders.push({
        id: order.id,
        userId: order.user_id,
        customerName: order.customer_name,
        customerEmail: order.customer_email,
        customerPhone: order.customer_phone,
        shippingAddress: JSON.parse(order.shipping_address),
        total: order.total,
        paymentMethod: order.payment_method,
        paymentStatus: order.payment_status,
        shiprocketShipmentId: order.shiprocket_shipment_id,
        shiprocketAwb: order.shiprocket_awb,
        status: order.status,
        date: order.date,
        items: mappedItems
      });
    }

    res.json(mappedOrders);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.get('/api/orders', authenticateToken, requireAdminOrSuper, async (req, res) => {
  try {
    const orders = await dbQuery("SELECT * FROM orders ORDER BY date DESC");
    const mappedOrders = [];

    for (const order of orders) {
      const items = await dbQuery("SELECT * FROM order_items WHERE order_id = ?", [order.id]);
      
      const mappedItems = items.map(i => ({
        id: i.product_id,
        name: i.product_name,
        quantity: i.quantity,
        price: i.price
      }));

      mappedOrders.push({
        id: order.id,
        userId: order.user_id,
        customerName: order.customer_name,
        customerEmail: order.customer_email,
        customerPhone: order.customer_phone,
        shippingAddress: JSON.parse(order.shipping_address),
        total: order.total,
        paymentMethod: order.payment_method,
        paymentStatus: order.payment_status,
        shiprocketShipmentId: order.shiprocket_shipment_id,
        shiprocketAwb: order.shiprocket_awb,
        status: order.status,
        date: order.date,
        items: mappedItems
      });
    }

    res.json(mappedOrders);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.put('/api/orders/:id/status', authenticateToken, requireSuperAdmin, async (req, res) => {
  const { status } = req.body;
  if (!status) {
    return res.status(400).json({ error: 'Bad Request', message: 'Status parameter required.' });
  }

  try {
    const existing = await dbGet("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: 'Not Found', message: 'Order not found.' });
    }

    await dbRun("UPDATE orders SET status = ? WHERE id = ?", [status, req.params.id]);
    res.json({ message: 'Order shipment status updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/orders/:id/request-cancel', authenticateToken, async (req, res) => {
  try {
    const order = await dbGet("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    if (!order) {
      return res.status(404).json({ error: 'Not Found', message: 'Order not found.' });
    }
    if (order.status !== 'Processing') {
      return res.status(400).json({ error: 'Bad Request', message: 'Only processing orders can be requested for cancellation.' });
    }

    await dbRun("UPDATE orders SET status = 'Cancellation Pending' WHERE id = ?", [req.params.id]);

    const notifId = 'notif-' + Math.random().toString(36).substr(2, 9);
    await dbRun(
      `INSERT INTO notifications (id, title, \`desc\`, \`read\`) VALUES (?, ?, ?, 0)`,
      [notifId, `Order Cancellation Request`, `Cancellation requested for order ${order.id} by ${order.customer_name}.`]
    );

    res.json({ message: 'Cancellation request logged for Super-Admin review.' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// Live shipment tracking synced using dynamic Shiprocket timelines
app.get('/api/orders/:id/tracking', authenticateToken, async (req, res) => {
  try {
    const order = await dbGet("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    if (!order) {
      return res.status(404).json({ error: 'Not Found', message: 'Order not found.' });
    }

    // Generate time elapsed shipment details based on AWB
    const tracking = getShiprocketTracking(order.shiprocket_awb || 'SR_MOCK_AWB', order.date);
    
    // Sync live tracking state with internal database status if it progressed automatically
    if (tracking.status !== order.status) {
      await dbRun("UPDATE orders SET status = ? WHERE id = ?", [tracking.status, order.id]);
    }
    
    res.json(tracking);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});


// --- 6. Admin User Management APIs ---

app.get('/api/admin/users', authenticateToken, requireAdminOrSuper, async (req, res) => {
  try {
    const users = await dbQuery("SELECT id, name, email, phone, role, location, is_blocked, created_at FROM users ORDER BY created_at DESC");
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.put('/api/admin/users/:id/block', authenticateToken, requireSuperAdmin, async (req, res) => {
  const { isBlocked } = req.body;
  const blockVal = isBlocked ? 1 : 0;
  try {
    const targetUser = await dbGet("SELECT * FROM users WHERE id = ?", [req.params.id]);
    if (!targetUser) {
      return res.status(404).json({ error: 'Not Found', message: 'User not found.' });
    }
    if (targetUser.role === 'super_admin') {
      return res.status(400).json({ error: 'Bad Request', message: 'Super Administrator accounts cannot be suspended.' });
    }
    await dbRun("UPDATE users SET is_blocked = ? WHERE id = ?", [blockVal, req.params.id]);
    res.json({ message: `User account successfully ${isBlocked ? 'suspended' : 'activated'}.` });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.put('/api/admin/users/:id/role', authenticateToken, requireSuperAdmin, async (req, res) => {
  const { role, location } = req.body;
  if (!role) {
    return res.status(400).json({ error: 'Bad Request', message: 'Role parameter is required.' });
  }
  try {
    const targetUser = await dbGet("SELECT * FROM users WHERE id = ?", [req.params.id]);
    if (!targetUser) {
      return res.status(404).json({ error: 'Not Found', message: 'User not found.' });
    }
    if (targetUser.role === 'super_admin' && role !== 'super_admin') {
      return res.status(400).json({ error: 'Bad Request', message: 'Super Administrator role cannot be demoted directly.' });
    }
    
    const assignedLocation = role === 'admin' ? (location || 'Hyderabad') : null;
    await dbRun("UPDATE users SET role = ?, location = ? WHERE id = ?", [role, assignedLocation, req.params.id]);
    res.json({ message: 'User role and location updated successfully.', role, location: assignedLocation });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});


// --- 7. Gurukulam Classes APIs ---
app.get('/api/classes', async (req, res) => {
  try {
    const classes = await dbQuery("SELECT * FROM classes");
    res.json(classes);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/classes', authenticateToken, requireAdminOrSuper, async (req, res) => {
  const { title, instructor_name, time, fee, image, description } = req.body;
  if (!title || !instructor_name || !time || fee === undefined || !image || !description) {
    return res.status(400).json({ error: 'Bad Request', message: 'All class details are required.' });
  }
  try {
    const classId = 'cls-' + Math.random().toString(36).substr(2, 9);
    await dbRun(
      "INSERT INTO classes (id, title, instructor_name, time, fee, image, description) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [classId, title, instructor_name, time, fee, image, description]
    );
    res.status(201).json({ message: 'Gurukulam class batch added successfully.', classId });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/classes/:id/register', authenticateToken, async (req, res) => {
  const classId = req.params.id;
  try {
    const cls = await dbGet("SELECT * FROM classes WHERE id = ?", [classId]);
    if (!cls) {
      return res.status(404).json({ error: 'Not Found', message: 'Class not found.' });
    }
    
    // Check if already registered
    const existing = await dbGet("SELECT * FROM class_registrations WHERE class_id = ? AND user_id = ?", [classId, req.user.id]);
    if (existing) {
      return res.status(400).json({ error: 'Bad Request', message: 'You are already registered for this Gurukulam class.' });
    }

    const regId = 'reg-' + Math.random().toString(36).substr(2, 9);
    await dbRun(
      "INSERT INTO class_registrations (id, class_id, user_id, user_name, user_email) VALUES (?, ?, ?, ?, ?)",
      [regId, classId, req.user.id, req.user.name, req.user.email]
    );
    res.json({ message: 'Successfully registered for the class!' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.get('/api/classes/:id/registrations', authenticateToken, requireAdminOrSuper, async (req, res) => {
  try {
    const regs = await dbQuery("SELECT * FROM class_registrations WHERE class_id = ? ORDER BY date DESC", [req.params.id]);
    res.json(regs);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});


// --- 8. Vetted Purohits Booking APIs ---
app.get('/api/purohits', async (req, res) => {
  try {
    const purohits = await dbQuery("SELECT * FROM purohits ORDER BY rating DESC, bookings_count DESC");
    res.json(purohits);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/purohits', authenticateToken, requireAdminOrSuper, async (req, res) => {
  const { name, specialization, fee, image, location } = req.body;
  if (!name || !specialization || !location) {
    return res.status(400).json({ error: 'Bad Request', message: 'Purohit Name, Specialization, and Location are required.' });
  }

  try {
    const id = 'purohit-' + Math.random().toString(36).substr(2, 9);
    const details = { id, name, specialization, fee: fee || 0, image: image || '', location };

    if (req.user.role === 'super_admin') {
      // Commit directly
      await dbRun(
        `INSERT INTO purohits (id, name, specialization, rating, fee, image, location, bookings_count)
         VALUES (?, ?, ?, 5.0, ?, ?, ?, 0)`,
        [id, name, specialization, fee || 0, image || '', location]
      );
      return res.status(201).json({ message: 'Purohit created successfully.', purohit: details });
    } else {
      // Create proposal queue item
      const proposalId = 'prop-' + Math.random().toString(36).substr(2, 9);
      await dbRun(
        `INSERT INTO proposals (id, proposer_id, proposer_name, proposer_location, action_type, product_id, details)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [proposalId, req.user.id, req.user.name, req.user.location || 'Unknown', 'add_purohit', id, JSON.stringify(details)]
      );
      // Dynamic Notification Logger
      const notifId = 'notif-' + Math.random().toString(36).substr(2, 9);
      await dbRun(
        `INSERT INTO notifications (id, title, \`desc\`, \`read\`) VALUES (?, ?, ?, 0)`,
        [notifId, `Purohit Registration Proposal from ${req.user.name}`, `Admin proposed adding new Purohit: ${name} at the ${req.user.location || 'Unknown'} hub.`]
      );
      return res.status(202).json({ message: 'Request submitted for Super Admin approval.', proposalId });
    }
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.get('/api/admin/welfare', authenticateToken, requireAdminOrSuper, async (req, res) => {
  try {
    const purohits = await dbQuery("SELECT id, name, location, bookings_count, fee FROM purohits ORDER BY bookings_count DESC");
    const ledger = purohits.map(p => {
      // 10% PF contribution based on standard fee, defaulting to ₹3500 if zero
      const baseFee = p.fee || 3500;
      const pfBalance = p.bookings_count * (baseFee * 0.10);
      return {
        id: p.id,
        name: p.name,
        location: p.location,
        bookingsCount: p.bookings_count,
        pfBalance: pfBalance,
        insuranceStatus: p.bookings_count > 0 ? 'Active' : 'Pending Booking',
        insuranceCover: 500000
      };
    });
    res.json(ledger);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/purohits/:id/book', authenticateToken, async (req, res) => {
  const purohitId = req.params.id;
  const { poojaType, bookingDate, timeSlot, address } = req.body;
  if (!poojaType || !bookingDate || !timeSlot || !address) {
    return res.status(400).json({ error: 'Bad Request', message: 'All booking fields are required.' });
  }
  try {
    const purohit = await dbGet("SELECT * FROM purohits WHERE id = ?", [purohitId]);
    if (!purohit) {
      return res.status(404).json({ error: 'Not Found', message: 'Purohit not found.' });
    }

    const defaultChecklist = poojaType === 'Vivaham' 
      ? [
          { id: 'item-1', name: 'Organic Pasupu (Turmeric Powder) - 100g', quantity: 5, price: 149, isStoreProduct: true, storeProductId: 'p1' },
          { id: 'item-2', name: 'Organic Kumkum - 100g', quantity: 2, price: 129, isStoreProduct: true, storeProductId: 'p2' },
          { id: 'item-3', name: 'Gandham (Chandanam Sandalwood Paste) - 50g', quantity: 2, price: 249, isStoreProduct: true, storeProductId: 'p3' },
          { id: 'item-4', name: 'Yagnopavitam (Sacred Janeu Cotton Threads)', quantity: 3, price: 199, isStoreProduct: true, storeProductId: 'p5' },
          { id: 'item-5', name: 'Complete 5-in-1 Puja Combo Kit', quantity: 1, price: 599, isStoreProduct: true, storeProductId: 'p6' },
          { id: 'item-6', name: 'Sacred Vibhuti (Holy Ash) - 100g', quantity: 1, price: 99, isStoreProduct: true, storeProductId: 'p4' },
          { id: 'item-7', name: 'Sacred Coconuts (for Kalasha puja)', quantity: 4, price: 40, isStoreProduct: false },
          { id: 'item-8', name: 'Betel Leaves & Areca Nuts Bundle', quantity: 1, price: 50, isStoreProduct: false }
        ]
      : poojaType === 'Satyanarayana Vratam'
      ? [
          { id: 'item-1', name: 'Complete 5-in-1 Puja Combo Kit', quantity: 1, price: 599, isStoreProduct: true, storeProductId: 'p6' },
          { id: 'item-2', name: 'Organic Pasupu (Turmeric Powder) - 100g', quantity: 2, price: 149, isStoreProduct: true, storeProductId: 'p1' },
          { id: 'item-3', name: 'Organic Kumkum - 100g', quantity: 1, price: 129, isStoreProduct: true, storeProductId: 'p2' },
          { id: 'item-4', name: 'Gandham (Chandanam Sandalwood Paste) - 50g', quantity: 1, price: 249, isStoreProduct: true, storeProductId: 'p3' },
          { id: 'item-5', name: 'Sacred Coconuts', quantity: 2, price: 40, isStoreProduct: false }
        ]
      : [
          { id: 'item-1', name: 'Complete 5-in-1 Puja Combo Kit', quantity: 1, price: 599, isStoreProduct: true, storeProductId: 'p6' },
          { id: 'item-2', name: 'Organic Pasupu (Turmeric Powder) - 100g', quantity: 1, price: 149, isStoreProduct: true, storeProductId: 'p1' },
          { id: 'item-3', name: 'Organic Kumkum - 100g', quantity: 1, price: 129, isStoreProduct: true, storeProductId: 'p2' }
        ];

    const bookingId = 'bk-' + Math.random().toString(36).substr(2, 9);
    await dbRun(
      `INSERT INTO purohit_bookings (id, purohit_id, user_id, pooja_type, booking_date, time_slot, address, status, items, secure_deposit)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Confirmed', ?, 500)`,
      [bookingId, purohitId, req.user.id, poojaType, bookingDate, timeSlot, address, JSON.stringify(defaultChecklist)]
    );

    // Increment bookings count
    await dbRun("UPDATE purohits SET bookings_count = bookings_count + 1 WHERE id = ?", [purohitId]);

    // Send a notification to Admin
    const notifId = 'notif-' + Math.random().toString(36).substr(2, 9);
    await dbRun(
      `INSERT INTO notifications (id, title, \`desc\`, \`read\`) VALUES (?, ?, ?, 0)`,
      [notifId, `New Purohit Booking`, `Purohit booking ${bookingId} placed by ${req.user.name} for ${poojaType} on ${bookingDate}.`]
    );

    res.status(201).json({ message: 'Purohit booking placed and confirmed successfully!', bookingId });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.get('/api/purohits/bookings/my', authenticateToken, async (req, res) => {
  try {
    const bookings = await dbQuery(
      `SELECT b.*, p.name as purohit_name, p.image as purohit_image, p.specialization as purohit_specialization, p.location as purohit_location
       FROM purohit_bookings b
       JOIN purohits p ON b.purohit_id = p.id
       WHERE b.user_id = ?`,
      [req.user.id]
    );
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// Sync Devotee checklist items and platform purchase state with booking record
app.put('/api/bookings/:id/items', authenticateToken, async (req, res) => {
  const { items, itemsPurchased } = req.body;
  if (!items) {
    return res.status(400).json({ error: 'Bad Request', message: 'Puja checklist items list required.' });
  }
  try {
    await dbRun(
      "UPDATE purohit_bookings SET items = ?, items_purchased = ? WHERE id = ?",
      [JSON.stringify(items), itemsPurchased ? 1 : 0, req.params.id]
    );
    res.json({ message: 'Booking checklist items successfully synchronized with priest workspace! 🌿' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});


// --- 8.5 Priest (Purohit) Dashboards & Quotations Exchange APIs ---

// 1. Priest Profile: Get Priest record matching logged-in user ID
app.get('/api/purohit/profile', authenticateToken, async (req, res) => {
  if (req.user.role !== 'purohit') {
    return res.status(403).json({ error: 'Forbidden', message: 'Only Purohits can access this profile.' });
  }
  try {
    const purohit = await dbGet("SELECT * FROM purohits WHERE id = ?", [req.user.id]);
    if (!purohit) {
      return res.status(404).json({ error: 'Not Found', message: 'Purohit record not found.' });
    }
    
    // Calculate dynamic secure deposits from confirmed bookings!
    const depositsObj = await dbGet("SELECT SUM(secure_deposit) as total FROM purohit_bookings WHERE purohit_id = ? AND status = 'Confirmed'", [req.user.id]);
    const secureDeposits = depositsObj?.total || 0;

    // Calculate PF Balance
    const baseFee = purohit.fee || 3500;
    const pfBalance = purohit.bookings_count * (baseFee * 0.10);

    // Calculate dynamic reviews
    const reviews = await dbQuery("SELECT * FROM purohit_reviews WHERE purohit_id = ? ORDER BY created_at DESC", [req.user.id]);
    const reviewCount = reviews.length;

    // Calculate Performance Reward Points
    let rewardsPoints = 0;
    reviews.forEach(r => {
      if (r.rating === 5) rewardsPoints += 100;
      else if (r.rating === 4) rewardsPoints += 50;
    });

    // Dynamic Welfare Credit Tier
    let creditScoreRating = 'Patanjali Tier';
    let creditLimit = 20000;
    if (purohit.bookings_count >= 10 && purohit.rating >= 4.8) {
      creditScoreRating = 'Vashistha Tier';
      creditLimit = 100000;
    } else if (purohit.bookings_count >= 5 && purohit.rating >= 4.5) {
      creditScoreRating = 'Vyasa Tier';
      creditLimit = 50000;
    }

    res.json({
      ...purohit,
      pfBalance,
      secureDeposits,
      rewardsPoints,
      creditScoreRating,
      creditLimit,
      reviews,
      reviewCount,
      insuranceStatus: purohit.bookings_count > 0 ? 'Active' : 'Pending Booking',
      insuranceCover: 500000,
      insurancePolicyId: `GP-INS-${purohit.id.toUpperCase().slice(-5)}-2026`
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// 2. Priest Bookings: Get bookings assigned to logged-in priest user ID
app.get('/api/purohit/bookings', authenticateToken, async (req, res) => {
  if (req.user.role !== 'purohit') {
    return res.status(403).json({ error: 'Forbidden', message: 'Only Purohits can access these bookings.' });
  }
  try {
    const bookings = await dbQuery(
      `SELECT b.*, u.name as user_name, u.email as user_email, u.phone as user_phone
       FROM purohit_bookings b
       JOIN users u ON b.user_id = u.id
       WHERE b.purohit_id = ?
       ORDER BY b.booking_date DESC`,
      [req.user.id]
    );
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// 3. Devotee Custom Quotation Submit
app.post('/api/quotes', authenticateToken, async (req, res) => {
  const { purohitId, pujaType, preferredDate, details } = req.body;
  if (!pujaType || !preferredDate || !details) {
    return res.status(400).json({ error: 'Bad Request', message: 'Puja type, preferred date, and requirements details are required.' });
  }
  try {
    let priestName = null;
    if (purohitId) {
      const priest = await dbGet("SELECT name FROM purohits WHERE id = ?", [purohitId]);
      if (priest) priestName = priest.name;
    }
    const id = 'qt-' + Math.random().toString(36).substr(2, 9);
    await dbRun(
      `INSERT INTO puja_quotes (id, user_id, user_name, purohit_id, purohit_name, puja_type, preferred_date, details, quote_amount, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'Pending Quote')`,
      [id, req.user.id, req.user.name, purohitId || null, priestName, pujaType, preferredDate, details]
    );

    // Send alert to Admin
    const notifId = 'notif-' + Math.random().toString(36).substr(2, 9);
    await dbRun(
      `INSERT INTO notifications (id, title, \`desc\`, \`read\`) VALUES (?, ?, ?, 0)`,
      [notifId, `New Custom Quote Request`, `${req.user.name} requested custom quote for ${pujaType} on ${preferredDate}.`]
    );

    res.status(201).json({ message: 'Quotation request submitted successfully!', id });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// 4. Devotee View Own Quotation Requests
app.get('/api/quotes/my', authenticateToken, async (req, res) => {
  try {
    const quotes = await dbQuery("SELECT * FROM puja_quotes WHERE user_id = ? ORDER BY created_at DESC", [req.user.id]);
    res.json(quotes);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// 5. Devotee Accept Quotation: Converts quote to confirmed booking and increments bookings_count!
app.post('/api/quotes/:id/accept', authenticateToken, async (req, res) => {
  try {
    const quote = await dbGet("SELECT * FROM puja_quotes WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
    if (!quote) {
      return res.status(404).json({ error: 'Not Found', message: 'Quote request not found.' });
    }
    if (quote.status !== 'Quote Sent') {
      return res.status(400).json({ error: 'Bad Request', message: 'Only received quotations can be accepted.' });
    }

    // Auto-create Purohit booking with default items & ₹500 secure deposit
    const bookingId = 'bk-' + Math.random().toString(36).substr(2, 9);
    const bookingDate = quote.preferred_date;
    const timeSlot = '09:00 AM - 11:30 AM';
    const address = quote.details;
    const purohitId = quote.purohit_id || 'purohit-1'; // fallback

    const defaultChecklist = [
      { id: 'item-1', name: 'Complete 5-in-1 Puja Combo Kit', quantity: 1, price: 599, isStoreProduct: true, storeProductId: 'p6' },
      { id: 'item-2', name: 'Organic Pasupu (Turmeric Powder) - 100g', quantity: 1, price: 149, isStoreProduct: true, storeProductId: 'p1' },
      { id: 'item-3', name: 'Organic Kumkum - 100g', quantity: 1, price: 129, isStoreProduct: true, storeProductId: 'p2' }
    ];

    await dbRun(
      `INSERT INTO purohit_bookings (id, purohit_id, user_id, pooja_type, booking_date, time_slot, address, status, items, secure_deposit)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Confirmed', ?, 500)`,
      [bookingId, purohitId, req.user.id, `${quote.puja_type} (Custom quote accepted ₹${quote.quote_amount})`, bookingDate, timeSlot, address, JSON.stringify(defaultChecklist)]
    );

    // Increment bookings count
    await dbRun("UPDATE purohits SET bookings_count = bookings_count + 1 WHERE id = ?", [purohitId]);

    // Update quote status
    await dbRun("UPDATE puja_quotes SET status = 'Accepted' WHERE id = ?", [req.params.id]);

    // Send Alert to admin
    const notifId = 'notif-' + Math.random().toString(36).substr(2, 9);
    await dbRun(
      `INSERT INTO notifications (id, title, \`desc\`, \`read\`) VALUES (?, ?, ?, 0)`,
      [notifId, `Custom Quote Accepted`, `${req.user.name} accepted quote ₹${quote.quote_amount} for ${quote.puja_type} booking ${bookingId}.`]
    );

    res.json({ message: 'Quotation accepted! Booking generated and scheduled successfully.', bookingId });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// 6. Devotee Reject Quotation
app.post('/api/quotes/:id/reject', authenticateToken, async (req, res) => {
  try {
    const quote = await dbGet("SELECT * FROM puja_quotes WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
    if (!quote) {
      return res.status(404).json({ error: 'Not Found', message: 'Quote request not found.' });
    }
    await dbRun("UPDATE puja_quotes SET status = 'Rejected' WHERE id = ?", [req.params.id]);
    res.json({ message: 'Quotation rejected successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// 7. Priest View Quotation Requests (unassigned or assigned to them)
app.get('/api/purohit/quotes', authenticateToken, async (req, res) => {
  if (req.user.role !== 'purohit') {
    return res.status(403).json({ error: 'Forbidden', message: 'Only Purohits can bid on quotations.' });
  }
  try {
    const quotes = await dbQuery(
      `SELECT * FROM puja_quotes 
       WHERE (purohit_id = ? OR purohit_id IS NULL) 
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(quotes);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// 8. Priest Send Quotation Bid
app.post('/api/purohit/quotes/:id/send', authenticateToken, async (req, res) => {
  if (req.user.role !== 'purohit') {
    return res.status(403).json({ error: 'Forbidden', message: 'Only Purohits can bid on quotations.' });
  }
  const { quoteAmount } = req.body;
  if (!quoteAmount || Number(quoteAmount) <= 0) {
    return res.status(400).json({ error: 'Bad Request', message: 'Valid quotation bid amount in Rupees (₹) is required.' });
  }
  try {
    const quote = await dbGet("SELECT * FROM puja_quotes WHERE id = ? AND (purohit_id = ? OR purohit_id IS NULL)", [req.params.id, req.user.id]);
    if (!quote) {
      return res.status(404).json({ error: 'Not Found', message: 'Quote request not found or assigned to another priest.' });
    }

    await dbRun(
      `UPDATE puja_quotes 
       SET quote_amount = ?, status = 'Quote Sent', purohit_id = ?, purohit_name = ?
       WHERE id = ?`,
      [Number(quoteAmount), req.user.id, req.user.name, req.params.id]
    );

    // Send Alert to Devotee (via notifications/system)
    const notifId = 'notif-' + Math.random().toString(36).substr(2, 9);
    await dbRun(
      `INSERT INTO notifications (id, title, \`desc\`, \`read\`) VALUES (?, ?, ?, 0)`,
      [notifId, `Puja Quote Received`, `Shri ${req.user.name} submitted a bid of ₹${quoteAmount} for your custom puja request.`]
    );

    res.json({ message: 'Quotation sent successfully to devotee!' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// 9. Super Admin: Global Bookings Audit Logs
app.get('/api/admin/bookings', authenticateToken, requireAdminOrSuper, async (req, res) => {
  try {
    const bookings = await dbQuery(
      `SELECT b.*, p.name as purohit_name, p.location as purohit_location, u.name as user_name, u.email as user_email, u.phone as user_phone
       FROM purohit_bookings b
       JOIN purohits p ON b.purohit_id = p.id
       JOIN users u ON b.user_id = u.id
       ORDER BY b.booking_date DESC`
    );
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// 10. Super Admin: Global Quotes Exchanged Audit Logs
app.get('/api/admin/quotes', authenticateToken, requireAdminOrSuper, async (req, res) => {
  try {
    const quotes = await dbQuery("SELECT * FROM puja_quotes ORDER BY created_at DESC");
    res.json(quotes);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});


// --- 9. Horoscopes Consulting APIs ---
app.post('/api/horoscopes/book', authenticateToken, async (req, res) => {
  const { name, dob, tob, pob, slotDate, slotTime } = req.body;
  if (!name || !dob || !tob || !pob || !slotDate || !slotTime) {
    return res.status(400).json({ error: 'Bad Request', message: 'All birth coordinates and time slots are required.' });
  }
  try {
    const horoscopeId = 'hr-' + Math.random().toString(36).substr(2, 9);
    await dbRun(
      "INSERT INTO horoscopes (id, user_id, name, dob, tob, pob, slot_date, slot_time, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Scheduled')",
      [horoscopeId, req.user.id, name, dob, tob, pob, slotDate, slotTime]
    );

    const notifId = 'notif-' + Math.random().toString(36).substr(2, 9);
    await dbRun(
      `INSERT INTO notifications (id, title, \`desc\`, \`read\`) VALUES (?, ?, ?, 0)`,
      [notifId, `New Horoscope Consultation`, `Horoscope reading scheduled by ${name} for ${slotDate} at ${slotTime}.`]
    );

    res.status(201).json({ message: 'Horoscope consulting session booked and scheduled!', horoscopeId });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.get('/api/horoscopes/my', authenticateToken, async (req, res) => {
  try {
    const consultations = await dbQuery("SELECT * FROM horoscopes WHERE user_id = ? ORDER BY slot_date DESC", [req.user.id]);
    res.json(consultations);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});


// --- 10. Satsang Spiritual Q&A Forum APIs ---
app.get('/api/queries', async (req, res) => {
  // Gracefully parse optional token for identity-based masking and owner tracking
  let currentUser = null;
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      currentUser = decoded;
    } catch(e) {}
  }

  try {
    const queries = await dbQuery("SELECT * FROM queries WHERE is_deleted = 0 ORDER BY date DESC");
    const result = [];
    for (const q of queries) {
      const replies = await dbQuery("SELECT * FROM replies WHERE query_id = ? ORDER BY date ASC", [q.id]);
      
      // Determine if logged-in user is the owner
      const isOwner = currentUser && q.user_name === currentUser.name;
      const isSuperAdmin = currentUser && currentUser.role === 'super_admin';
      const isPriestOrAdmin = currentUser && (currentUser.role === 'purohit' || currentUser.role === 'admin');

      // ✦ PREMIUM PRIVACY LOGIC ✦
      // In private mode:
      // - Before reply: visible ONLY to the devotee who asked (owner) AND purohits/admins/super-admins (who can reply)
      // - After reply: visible ONLY to the devotee who asked (owner) AND super-admins (disappears from other purohits/admins and standard users)
      if (q.is_private === 1) {
        const isVisible = isOwner || isSuperAdmin || (isPriestOrAdmin && replies.length === 0);
        if (!isVisible) {
          continue; // Skip returning this query entirely for privacy
        }
      }

      // Mask name for everyone EXCEPT super_admin and the owner themselves
      const mappedName = (q.is_private === 1 && !isSuperAdmin && !isOwner) ? 'Anonymous Devotee' : q.user_name;

      result.push({
        ...q,
        user_name: mappedName,
        is_owner: isOwner ? 1 : 0,
        replies
      });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// GET SuperAdmin Query Audit Logs (shows all queries including deleted ones, edited replies, and private identities)
app.get('/api/admin/queries-audit', authenticateToken, requireAdminOrSuper, async (req, res) => {
  try {
    const queries = await dbQuery("SELECT * FROM queries ORDER BY date DESC");
    const result = [];
    for (const q of queries) {
      const replies = await dbQuery("SELECT * FROM replies WHERE query_id = ? ORDER BY date ASC", [q.id]);
      result.push({
        ...q,
        replies
      });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/queries', authenticateToken, async (req, res) => {
  const { question, category, isPrivate } = req.body;
  if (!question || !category) {
    return res.status(400).json({ error: 'Bad Request', message: 'Question text and category are required.' });
  }
  try {
    const queryId = 'query-' + Math.random().toString(36).substr(2, 9);
    const isPrivateFlag = isPrivate ? 1 : 0;
    await dbRun(
      "INSERT INTO queries (id, user_name, question, category, is_private, is_deleted) VALUES (?, ?, ?, ?, ?, 0)",
      [queryId, req.user.name, question, category, isPrivateFlag]
    );
    res.status(201).json({ message: 'Spiritual question posted successfully to Satsang Forum.', queryId });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// Devotee soft delete query
app.delete('/api/queries/:id', authenticateToken, async (req, res) => {
  try {
    const query = await dbGet("SELECT * FROM queries WHERE id = ?", [req.params.id]);
    if (!query) {
      return res.status(404).json({ error: 'Not Found', message: 'Query not found.' });
    }
    // Only author or admin/superadmin can delete. Check by name.
    const isOwner = query.user_name === req.user.name;
    const isAuthorized = isOwner || req.user.role === 'admin' || req.user.role === 'super_admin';
    if (!isAuthorized) {
      return res.status(403).json({ error: 'Forbidden', message: 'You are not authorized to delete this query.' });
    }
    await dbRun("UPDATE queries SET is_deleted = 1, deleted_by = ? WHERE id = ?", [req.user.name, req.params.id]);
    res.json({ message: 'Spiritual query removed successfully from the Satsang UI but preserved backend.' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/queries/:id/replies', authenticateToken, async (req, res) => {
  const queryId = req.params.id;
  const { replyContent } = req.body;
  if (!replyContent) {
    return res.status(400).json({ error: 'Bad Request', message: 'Reply content cannot be blank.' });
  }
  try {
    const query = await dbGet("SELECT * FROM queries WHERE id = ?", [queryId]);
    if (!query) {
      return res.status(404).json({ error: 'Not Found', message: 'Query thread not found.' });
    }

    // Role representation: Purohit, Instructor, or Admin/SuperAdmin
    let replierRole = 'Devotee';
    if (req.user.role === 'super_admin') {
      replierRole = 'Super Admin';
    } else if (req.user.role === 'admin') {
      replierRole = 'Purohit Admin';
    } else if (req.user.role === 'purohit') {
      replierRole = 'Purohit';
    }

    const replyId = 'rep-' + Math.random().toString(36).substr(2, 9);
    await dbRun(
      "INSERT INTO replies (id, query_id, replier_name, replier_role, reply_content, is_edited) VALUES (?, ?, ?, ?, ?, 0)",
      [replyId, queryId, req.user.name, replierRole, replyContent]
    );

    // Dynamic First-Reply Notification & Soft-Deletion Workflow for Private Mode doubts
    if (query.is_private === 1) {
      const existingReplies = await dbQuery("SELECT * FROM replies WHERE query_id = ?", [queryId]);
      if (existingReplies && existingReplies.length === 1) {
        // Look up devotee to notify
        const devotee = await dbGet("SELECT * FROM users WHERE name = ?", [query.user_name]);
        if (devotee) {
          // Send SendGrid Email
          if (devotee.email) {
            const subject = `✦ Private Doubt Answered: ${query.category} ✦`;
            const htmlContent = `
              <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px dashed #C9943A; border-radius: 12px; max-width: 600px; background-color: #FCFBF8; margin: auto;">
                <h2 style="color: #5C0A20; text-align: center; border-bottom: 2px solid #C9943A; padding-bottom: 12px; font-family: 'Georgia', serif;">gurupadukam.com</h2>
                <p style="font-size: 15px; color: #1A1A1A;">Dear Devotee (<strong>${devotee.name}</strong>),</p>
                <p style="font-size: 14px; color: #333; line-height: 1.6;">Your private spiritual query on the Satsang Board has been resolved by our verified Acharya.</p>
                
                <div style="background-color: rgba(92,10,32,0.05); padding: 15px; border-left: 4px solid #5C0A20; margin: 15px 0;">
                  <p style="font-size: 13px; font-weight: bold; margin: 0; color: #5C0A20;">Your Question:</p>
                  <p style="font-size: 13px; font-style: italic; margin: 5px 0 0 0; color: #555;">"${query.question}"</p>
                </div>
                
                <div style="background-color: rgba(201,148,58,0.1); padding: 15px; border-left: 4px solid #C9943A; margin: 15px 0;">
                  <p style="font-size: 13px; font-weight: bold; margin: 0; color: #C9943A;">Acharya Reply (${req.user.name}):</p>
                  <p style="font-size: 13px; margin: 5px 0 0 0; color: #222;">"${replyContent}"</p>
                </div>

                <p style="font-size: 12px; color: #E74C3C; font-weight: bold; margin-top: 20px;">
                  ⚠️ Privacy Guarantee: Since this was marked as a Private Doubt, this question and its answer have been automatically archived and removed from the public website for your absolute security and confidentiality.
                </p>
                <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
                <p style="font-size: 10px; color: #999; text-align: center;">This is an automated spiritual alert. Please do not reply to this email.</p>
              </div>
            `;
            await sendEmailNotification(devotee.email, subject, htmlContent);
          }

          // Send Twilio SMS
          if (devotee.phone) {
            const smsText = `✦ Gurupadukam Satsang ✦\nRespected Devotee, your private doubt "${query.question.slice(0, 30)}..." has been answered by ${req.user.name}.\n\nReply: "${replyContent.slice(0, 100)}..."\n\nFor privacy, this doubt has been archived and removed from the public board.`;
            await sendSMSNotification(devotee.phone, smsText);
          }
        }

        // Private mode queries will dynamically disappear from public feeds after the first reply (handled in GET /api/queries).
        // No need to hard-toggle is_deleted = 1 so that the devotee owner can still view their answer.
        
        // Log notification to Admin
        const notifId = 'notif-' + Math.random().toString(36).substr(2, 9);
        await dbRun(
          `INSERT INTO notifications (id, title, \`desc\`, \`read\`) VALUES (?, ?, ?, 0)`,
          [notifId, `Private Doubt Auto-Archived`, `Private doubt query ${queryId} answered by ${req.user.name} and archived safely.`]
        );
      }
    }

    res.status(201).json({ message: 'Reply posted to Satsang Thread.', replyId });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// Edit Reply (Purohits, instructors or admins can edit their replies, backend logs edit histories)
app.put('/api/queries/replies/:replyId', authenticateToken, async (req, res) => {
  const { replyContent } = req.body;
  if (!replyContent || !replyContent.trim()) {
    return res.status(400).json({ error: 'Bad Request', message: 'Modified reply content is required.' });
  }
  try {
    const reply = await dbGet("SELECT * FROM replies WHERE id = ?", [req.params.replyId]);
    if (!reply) {
      return res.status(404).json({ error: 'Not Found', message: 'Reply not found.' });
    }
    // Authorized to edit if owned or admin
    const isOwner = reply.replier_name === req.user.name;
    const isAuthorized = isOwner || req.user.role === 'admin' || req.user.role === 'super_admin';
    if (!isAuthorized) {
      return res.status(403).json({ error: 'Forbidden', message: 'You are not authorized to edit this reply.' });
    }
    // Log original content in audit ledger if editing for the first time
    const originalText = reply.is_edited === 1 ? reply.original_content : reply.reply_content;
    await dbRun(
      "UPDATE replies SET reply_content = ?, original_content = ?, is_edited = 1 WHERE id = ?",
      [replyContent, originalText, req.params.replyId]
    );
    res.json({ message: 'Reply modified successfully. Audit logs updated.' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});


// --- 8.8 Purohits Reviews Feedback Loop API ---
app.post('/api/purohits/:id/reviews', authenticateToken, async (req, res) => {
  const { rating, reviewText, bookingId } = req.body;
  const purohitId = req.params.id;

  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Bad Request', message: 'Star rating from 1 to 5 required.' });
  }
  if (!bookingId) {
    return res.status(400).json({ error: 'Bad Request', message: 'Valid booking reference is required.' });
  }

  try {
    const reviewId = 'rev-' + Math.random().toString(36).substr(2, 9);
    await dbRun(
      `INSERT INTO purohit_reviews (id, booking_id, purohit_id, user_name, rating, review_text)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [reviewId, bookingId, purohitId, req.user.name, Number(rating), reviewText || '']
    );

    // Update booking status
    await dbRun("UPDATE purohit_bookings SET status = 'Reviewed' WHERE id = ?", [bookingId]);

    // Recalculate and update the Purohit average rating
    const avgObj = await dbGet("SELECT AVG(rating) as avg, COUNT(*) as count FROM purohit_reviews WHERE purohit_id = ?", [purohitId]);
    if (avgObj && avgObj.avg) {
      await dbRun("UPDATE purohits SET rating = ? WHERE id = ?", [avgObj.avg, purohitId]);
    }

    res.status(201).json({ message: '✦ Review logged successfully! Thank you for the feedback. ✦', reviewId });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// --- 8.9 Cottage Partners Dashboard & Craft Proposals APIs ---
app.get('/api/cottage/profile', authenticateToken, async (req, res) => {
  if (req.user.role !== 'cottage_partner') {
    return res.status(403).json({ error: 'Forbidden', message: 'Only Cottage Partners can access this profile.' });
  }
  try {
    const partner = await dbGet("SELECT * FROM cottage_partners WHERE id = ?", [req.user.id]);
    if (!partner) {
      return res.status(404).json({ error: 'Not Found', message: 'Artisan record not found.' });
    }
    res.json(partner);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.get('/api/cottage/proposals', authenticateToken, async (req, res) => {
  if (req.user.role !== 'cottage_partner') {
    return res.status(403).json({ error: 'Forbidden', message: 'Only Cottage Partners can view proposals.' });
  }
  try {
    const proposals = await dbQuery("SELECT * FROM proposals WHERE proposer_id = ? ORDER BY created_at DESC", [req.user.id]);
    res.json(proposals);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/cottage/propose', authenticateToken, async (req, res) => {
  if (req.user.role !== 'cottage_partner') {
    return res.status(403).json({ error: 'Forbidden', message: 'Only Cottage Partners can propose products.' });
  }
  const { name, category, price, description, image } = req.body;
  if (!name || !price || !description) {
    return res.status(400).json({ error: 'Bad Request', message: 'Product name, standard price, and description are required.' });
  }
  try {
    const proposalId = 'prop-' + Math.random().toString(36).substr(2, 9);
    const details = JSON.stringify({ name, category: category || 'incense', price: Number(price), description, image: image || '' });
    
    await dbRun(
      `INSERT INTO proposals (id, proposer_id, proposer_name, proposer_location, action_type, details, status)
       VALUES (?, ?, ?, ?, 'create_product', ?, 'pending')`,
      [proposalId, req.user.id, req.user.name, req.user.location || 'Hyderabad', details]
    );

    // Alert Super Admin
    const notifId = 'notif-' + Math.random().toString(36).substr(2, 9);
    await dbRun(
      `INSERT INTO notifications (id, title, \`desc\`, \`read\`) VALUES (?, ?, ?, 0)`,
      [notifId, `New Artisan Craft Proposal`, `Cottage Partner ${req.user.name} proposed item: ${name} (₹${price}).`]
    );

    res.status(201).json({ message: 'Artisan craft proposal submitted successfully! Pending approval. 🌿', proposalId });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// Serve frontend compiled client assets directly from Express
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDistPath = path.join(__dirname, '../frontend/dist');
app.use(express.static(frontendDistPath));

app.use((req, res, next) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/api-proxy') || req.url.startsWith('/ws-proxy')) {
    return next();
  }
  res.sendFile(path.join(frontendDistPath, 'index.html'));
});


// ==========================================
// ============ UPGRADE WEBSOCKET ============
// ==========================================

const server = app.listen(PORT, API_BACKEND_HOST, () => {
  console.log(`Guru Padukam Production Backend listening at http://localhost:${PORT}`);
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname === '/ws-proxy') {
    let targetUrl = url.searchParams.get('target');
    if (!targetUrl) {
      socket.destroy();
      return;
    }

    if (targetUrl === 'wss://aiplatform.googleapis.com//ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent') {
      const location = GOOGLE_CLOUD_LOCATION === 'global' ? 'us-central1' : GOOGLE_CLOUD_LOCATION;
      targetUrl = `wss://${location}-aiplatform.googleapis.com//ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent`;
    } else {
      socket.destroy();
      return;
    }

    let accessToken;
    try {
      accessToken = await getAccessToken();
      if (!accessToken) throw new Error('No token');
    } catch (err) {
      socket.destroy();
      return;
    }

    let upstreamWs;
    try {
      upstreamWs = new WebSocket(targetUrl, {
        headers: getRequestHeaders(accessToken)
      });
    } catch (e) {
      socket.destroy();
      return;
    }

    const initialErrorHandler = (error) => {
      upstreamWs.removeEventListener('open', onUpstreamOpen);
      if (socket.writable) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        socket.destroy();
      }
    };

    upstreamWs.once('error', initialErrorHandler);

    const onUpstreamOpen = () => {
      upstreamWs.removeListener('error', initialErrorHandler);

      wss.handleUpgrade(request, socket, head, (ws) => {
        upstreamWs.on('message', (data, isBinary) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(data, { binary: isBinary });
          }
        });

        ws.on('message', (data, isBinary) => {
          let dataJson = {};
          try {
            dataJson = JSON.parse(data.toString());
          } catch (error) {
            ws.close(1011, 'Failed to parse message');
          }

          if (dataJson['setup']) {
            dataJson['setup']['model'] = `projects/${GOOGLE_CLOUD_PROJECT}/locations/${GOOGLE_CLOUD_LOCATION}/${dataJson['setup']['model']}`;
          }

          if (upstreamWs.readyState === WebSocket.OPEN) {
            upstreamWs.send(JSON.stringify(dataJson), { binary: false });
          }
        });

        upstreamWs.on('error', (error) => {
          ws.close(1011, error.message);
        });

        upstreamWs.on('close', (code, reason) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(code, reason);
          }
        });

        ws.on('error', (error) => {
          upstreamWs.close(1011, error.message);
        });

        ws.on('close', (code, reason) => {
          if (upstreamWs.readyState === WebSocket.OPEN) {
            upstreamWs.close(1000, reason);
          }
        });

        wss.emit('connection', ws, request);
      });
    };

    upstreamWs.once('open', onUpstreamOpen);
  } else {
    socket.destroy();
  }
});
