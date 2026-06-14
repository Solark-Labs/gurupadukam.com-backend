/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '.env') });
dotenv.config({ path: path.resolve(__dirname, '.env.local') });

import express from 'express';
import { GoogleAuth } from 'google-auth-library';
import fetch from 'node-fetch';
import rateLimit from 'express-rate-limit';
import { WebSocketServer, WebSocket } from 'ws';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import cron from 'node-cron';
import fs from 'fs';

// --- E-Commerce Imports ---
import './database.js'; // Connection & Seeding
import { dbQuery, dbRun, dbGet, dbInitPromise } from './database.js';
import { authenticateToken, requireSuperAdmin, requireAdminOrSuper, requireRole, generateToken, JWT_SECRET } from './auth.js';
const requirePurohitRole = requireRole(['purohit', 'super_admin']);
const requireAdminOrSuperOrPurohit = requireRole(['admin', 'super_admin', 'purohit']);
import { createRazorpayOrder, verifyRazorpaySignature, getRazorpayKey } from './razorpay.js';
import { createShiprocketShipment, getShiprocketTracking } from './shiprocket.js';

const app = express();
app.use(express.json({limit: process?.env?.API_PAYLOAD_MAX_SIZE || "7mb"}));

const EMAIL_RELAY_URL = process.env.EMAIL_RELAY_URL || 'https://gurupadukam.com/email-relay.php';

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
const resetTokenStore = {}; // Key: token, Value: { email, expiresAt }

async function generateNextUserId(role) {
  let prefix = 'devotee';
  if (role === 'purohit') prefix = 'acharya';
  else if (role === 'admin' || role === 'super_admin') prefix = 'admin';
  else if (role === 'cottage_partner') prefix = 'cottage';

  try {
    const rows = await dbQuery(`SELECT id FROM users WHERE id LIKE '${prefix}\_%' ESCAPE '\\'`);
    let maxNum = 0;
    rows.forEach(r => {
      const parts = r.id.split('_');
      if (parts.length > 1) {
        const num = parseInt(parts[1]);
        if (!isNaN(num) && num > maxNum) {
          maxNum = num;
        }
      }
    });
    return `${prefix}_${maxNum + 1}`;
  } catch (e) {
    console.error('Error generating sequential user ID:', e.message);
    return `${prefix}_` + Math.floor(1000 + Math.random() * 9000);
  }
}

function generateICS(bookingId, poojaType, dateStr, timeSlot, meetLink, summary, description) {
  const pad = (num) => String(num).padStart(2, '0');
  
  let startHour = 9;
  let startMin = 0;
  let endHour = 11;
  let endMin = 0;

  try {
    const times = timeSlot.split('-');
    const startTimeStr = times[0].trim();
    const isPM = startTimeStr.toUpperCase().includes('PM');
    const parts = startTimeStr.replace(/(AM|PM)/i, '').trim().split(':');
    let hour = parseInt(parts[0]);
    let min = parseInt(parts[1] || '0');
    if (isPM && hour < 12) hour += 12;
    if (!isPM && hour === 12) hour = 0;
    startHour = hour;
    startMin = min;

    if (times[1]) {
      const endTimeStr = times[1].trim();
      const isEndPM = endTimeStr.toUpperCase().includes('PM');
      const endParts = endTimeStr.replace(/(AM|PM)/i, '').trim().split(':');
      let ehour = parseInt(endParts[0]);
      let emin = parseInt(endParts[1] || '0');
      if (isEndPM && ehour < 12) ehour += 12;
      if (!isEndPM && ehour === 12) ehour = 0;
      endHour = ehour;
      endMin = emin;
    } else {
      endHour = startHour + 2;
      endMin = startMin;
    }
  } catch (e) {}

  const d = new Date(dateStr);
  const year = d.getFullYear() || 2026;
  const month = pad((d.getMonth() + 1) || 6);
  const day = pad(d.getDate() || 15);

  const startDT = `${year}${month}${day}T${pad(startHour)}${pad(startMin)}00`;
  const endDT = `${year}${month}${day}T${pad(endHour)}${pad(endMin)}00`;

  const icsLines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Gurupadukam//Ritual Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:booking-${bookingId}@gurupadukam.com`,
    `DTSTAMP:${year}${month}${day}T000000Z`,
    `DTSTART;TZID=Asia/Kolkata:${startDT}`,
    `DTEND;TZID=Asia/Kolkata:${endDT}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description.replace(/\n/g, '\\n')}`,
    `LOCATION:${meetLink || 'Physical Venue'}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'BEGIN:VALARM',
    'TRIGGER:-PT30M',
    'ACTION:DISPLAY',
    `DESCRIPTION:Reminder for ${summary}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ];

  return icsLines.join('\r\n');
}

function generateGoogleCalendarUrl(bookingId, poojaType, dateStr, timeSlot, meetLink, summary, description) {
  const pad = (num) => String(num).padStart(2, '0');
  let startHour = 9;
  let endHour = 11;

  try {
    const times = timeSlot.split('-');
    const startTimeStr = times[0].trim();
    const isPM = startTimeStr.toUpperCase().includes('PM');
    const parts = startTimeStr.replace(/(AM|PM)/i, '').trim().split(':');
    let hour = parseInt(parts[0]);
    if (isPM && hour < 12) hour += 12;
    if (!isPM && hour === 12) hour = 0;
    startHour = hour;

    if (times[1]) {
      const endTimeStr = times[1].trim();
      const isEndPM = endTimeStr.toUpperCase().includes('PM');
      const endParts = endTimeStr.replace(/(AM|PM)/i, '').trim().split(':');
      let ehour = parseInt(endParts[0]);
      if (isEndPM && ehour < 12) ehour += 12;
      if (!isEndPM && ehour === 12) ehour = 0;
      endHour = ehour;
    } else {
      endHour = startHour + 2;
    }
  } catch (e) {}

  const d = new Date(dateStr);
  const year = d.getFullYear() || 2026;
  const month = pad((d.getMonth() + 1) || 6);
  const day = pad(d.getDate() || 15);

  const dStart = `${year}${month}${day}T${pad(startHour)}0000`;
  const dEnd = `${year}${month}${day}T${pad(endHour)}0000`;

  const baseUrl = 'https://calendar.google.com/calendar/render?action=TEMPLATE';
  const url = `${baseUrl}&text=${encodeURIComponent(summary)}&dates=${dStart}/${dEnd}&details=${encodeURIComponent(description)}&location=${encodeURIComponent(meetLink || 'Physical Venue')}`;
  return url;
}

// High-Fidelity sendEmailNotification supporting BOTH Hostinger SMTP and SendGrid Web API
async function sendEmailNotification(to, subject, htmlContent, attachments = []) {
  // 0. Check if Hostinger HTTPS Email Relay is active (Bypasses Render SMTP port blocks for free!)
  const emailRelayUrl = EMAIL_RELAY_URL;
  const proxyHeader = process.env.PROXY_HEADER || 'EPNwICjxdCRxm9E3KepJfD17JBHYY001fg';

  const relayAttachments = attachments.map(att => ({
    content: Buffer.isBuffer(att.content) ? att.content.toString('base64') : Buffer.from(att.content).toString('base64'),
    filename: att.filename,
    type: att.contentType || att.type || 'text/plain'
  }));

  if (emailRelayUrl) {
    try {
      const response = await fetch(emailRelayUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Header': proxyHeader
        },
        body: JSON.stringify({
          to: to,
          subject: subject,
          html: htmlContent,
          token: proxyHeader,
          attachments: relayAttachments
        })
      });
      if (response.ok) {
        console.log(`[Email Service] Real email sent successfully to ${to} via Hostinger HTTPS Relay.`);
        return true;
      } else {
        const errText = await response.text();
        console.warn(`[Email Service Relay Alert] Relay failed:`, errText);
      }
    } catch (err) {
      console.error(`[Email Service Relay Connection Error]:`, err.message);
    }
  }

  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = parseInt(process.env.SMTP_PORT || '465');
  const smtpUser = process.env.SMTP_USER;
  const smtpPassword = process.env.SMTP_PASSWORD;
  const smtpSenderName = process.env.SMTP_SENDER_NAME || 'Gurupadukam Board';
  
  // Use smtpUser for fromEmail when using SMTP to prevent authentication mismatch, otherwise fallback
  const fromEmail = smtpHost ? (smtpUser || process.env.SENDGRID_SENDER_EMAIL || 'care@gurupadukam.com') : (process.env.SENDGRID_SENDER_EMAIL || smtpUser || 'care@gurupadukam.com');

  // 1. Check if SMTP configuration is active
  if (smtpHost && smtpUser && smtpPassword) {
    try {
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465, // True for 465, false for 587/other ports
        auth: {
          user: smtpUser,
          pass: smtpPassword
        },
        connectionTimeout: 4000,
        greetingTimeout: 4000,
        socketTimeout: 4000,
        tls: {
          rejectUnauthorized: false
        }
      });
      
      const info = await transporter.sendMail({
        from: `"${smtpSenderName}" <${fromEmail}>`,
        to: to,
        subject: subject,
        html: htmlContent,
        attachments: attachments
      });
      
      console.log(`[Email Service] Real email sent successfully to ${to} via SMTP (MessageID: ${info.messageId}).`);
      return true;
    } catch (err) {
      console.error(`[Email Service SMTP Error Details]:`, err);
      return false;
    }
  }

  // 2. Fallback to SendGrid if configured
  const apiKey = process.env.SENDGRID_API_KEY;
  if (apiKey) {
    try {
      const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: fromEmail, name: smtpSenderName },
          subject: subject,
          content: [{ type: 'text/html', value: htmlContent }],
          attachments: relayAttachments
        })
      });
      if (response.ok) {
        console.log(`[Email Service] Real email sent successfully to ${to} via SendGrid.`);
        return true;
      } else {
        const errText = await response.text();
        console.error(`[Email Service SendGrid Error] SendGrid failed:`, errText);
        return false;
      }
    } catch (err) {
      console.error(`[Email Service SendGrid Handshake Error]:`, err.message);
      return false;
    }
  }

  // 3. Fallback to Simulation Mode (Mock)
  console.log(`[Email Service Simulation] Dispatching to ${to} | Subject: ${subject}`);
  return false;
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

// High-Fidelity sendWhatsAppNotification using Twilio WhatsApp API (fetch-based, zero external dependencies)
async function sendWhatsAppNotification(to, bodyText) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromPhone = process.env.TWILIO_PHONE_NUMBER;
  const whatsappFrom = process.env.TWILIO_WHATSAPP_NUMBER || fromPhone;

  if (!accountSid || !authToken || !whatsappFrom) {
    console.log(`[WhatsApp Service Mock] Dispatching WhatsApp to ${to} | Body: ${bodyText}`);
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
    
    const finalTo = formattedTo.startsWith('whatsapp:') ? formattedTo : `whatsapp:${formattedTo}`;
    const finalFrom = whatsappFrom.startsWith('whatsapp:') ? whatsappFrom : `whatsapp:${whatsappFrom}`;

    params.append('To', finalTo);
    params.append('From', finalFrom);
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
      console.log(`[WhatsApp Service] Real WhatsApp sent successfully to ${to} via Twilio.`);
      return true;
    } else {
      const errText = await response.text();
      console.error(`[WhatsApp Service Error] Twilio failed:`, errText);
      return false;
    }
  } catch (err) {
    console.error(`[WhatsApp Service Connection Error]:`, err.message);
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

function normalizePhone(phone) {
  if (!phone) return '';
  const clean = phone.replace(/\D/g, '');
  return clean.length >= 10 ? clean.slice(-10) : clean;
}

// Cached Google public keys for Firebase ID Token RS256 signature verification
let firebasePublicKeysCache = {
  keys: null,
  expiresAt: 0
};

async function getFirebasePublicKeys() {
  if (firebasePublicKeysCache.keys && firebasePublicKeysCache.expiresAt > Date.now()) {
    return firebasePublicKeysCache.keys;
  }
  try {
    const response = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
    if (!response.ok) throw new Error('Failed to fetch public certificates from Google.');
    const keys = await response.json();
    const cacheControl = response.headers.get('cache-control');
    let maxAge = 3600 * 1000;
    if (cacheControl) {
      const match = cacheControl.match(/max-age=(\d+)/);
      if (match) {
        maxAge = parseInt(match[1], 10) * 1000;
      }
    }
    firebasePublicKeysCache = { keys, expiresAt: Date.now() + maxAge };
    return keys;
  } catch (error) {
    console.error('✦ [Firebase Server Check] Error loading secure keys:', error.message);
    throw error;
  }
}

async function verifyFirebaseIdToken(idToken) {
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    throw new Error('Firebase Project ID is not configured in Render environment.');
  }
  const decodedHeader = jwt.decode(idToken, { complete: true });
  if (!decodedHeader || !decodedHeader.header || !decodedHeader.header.kid) {
    throw new Error('Invalid secure token header structure.');
  }
  const kid = decodedHeader.header.kid;
  const publicKeys = await getFirebasePublicKeys();
  const certificate = publicKeys[kid];
  if (!certificate) {
    throw new Error('Secure token kid does not match current Google credentials.');
  }
  const decoded = jwt.verify(idToken, certificate, {
    audience: projectId,
    issuer: `https://securetoken.google.com/${projectId}`,
    algorithms: ['RS256']
  });
  return decoded;
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
const API_BACKEND_HOST = process?.env?.API_BACKEND_HOST || "0.0.0.0";

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
  const { name, email, password, phone, role, location, specialization, fee, image, cottageCategory, cottageAddress, cottageCapacity, otp, emailCode, firebaseToken, bio, credentials, portfolioImages, govIdType, govIdNumber, govIdImage, transactionId } = req.body;
  if (!name || !email || !password || !phone) {
    return res.status(400).json({ error: 'Bad Request', message: 'Name, email, password, and mobile number are required.' });
  }

  try {
    const existing = await dbGet("SELECT * FROM users WHERE email = ?", [email]);
    if (existing) {
      return res.status(400).json({ error: 'Bad Request', message: 'Email address already registered.' });
    }

    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone || cleanPhone.length < 10) {
      return res.status(400).json({ error: 'Bad Request', message: 'A valid 10-digit mobile number is required.' });
    }
    const existingPhone = await dbGet("SELECT * FROM users WHERE phone = ? OR phone LIKE ?", [cleanPhone, '%' + cleanPhone]);
    if (existingPhone) {
      return res.status(400).json({ error: 'Bad Request', message: 'Mobile number already registered.' });
    }

    let targetRole = role || 'user';

    // Enforce email/phone verification for all registration roles
    if (firebaseToken) {
      // Verify via secure Firebase ID Token
      try {
        const decoded = await verifyFirebaseIdToken(firebaseToken);
        const decodedPhone = decoded.phone_number;
        if (!decodedPhone) {
          return res.status(400).json({ error: 'Verification Failed', message: 'Token does not contain a verified mobile number.' });
        }
        const cleanDecodedPhone = normalizePhone(decodedPhone);
        if (cleanDecodedPhone !== cleanPhone) {
          return res.status(400).json({ error: 'Verification Failed', message: 'The verified phone number does not match your inputted mobile coordinates.' });
        }
      } catch (err) {
        return res.status(400).json({ error: 'Verification Failed', message: err.message || 'Firebase phone authentication token validation failed.' });
      }
    } else if (emailCode) {
      // Verify via Email OTP (Cost-Free!)
      const record = otpStore[email];
      if (!record || record.code !== emailCode || record.expiresAt < Date.now()) {
        return res.status(400).json({ error: 'Verification Failed', message: 'Invalid or expired Email verification code.' });
      }
      delete otpStore[email];
    } else if (otp) {
      // Verify via Phone SMS OTP
      if (!cleanPhone || cleanPhone.length < 10) {
        return res.status(400).json({ error: 'Bad Request', message: 'A valid 10-digit mobile number is required for registration.' });
      }
      const record = otpStore[cleanPhone];
      if (!record || record.code !== otp || record.expiresAt < Date.now()) {
        return res.status(400).json({ error: 'Verification Failed', message: 'Invalid or expired Phone SMS OTP.' });
      }
      delete otpStore[cleanPhone];
    } else {
      return res.status(400).json({ error: 'Bad Request', message: 'Please provide either the Email verification code, Phone SMS OTP, or a secure Firebase ID Token to complete registration.' });
    }

    const userId = await generateNextUserId(role);
    const passwordHash = await bcrypt.hash(password, 10);
    
    let targetLocation = null;
    let isBlocked = 0; // Default active for customers

    if (role === 'purohit') {
      targetRole = 'purohit';
      targetLocation = location || 'Hyderabad';
      isBlocked = 1; // Pending payment & credentials verification
      
      // Enforce up to 3 portfolio images
      let portfolioImagesJson = '[]';
      if (portfolioImages) {
        try {
          let parsed = Array.isArray(portfolioImages) ? portfolioImages : JSON.parse(portfolioImages);
          if (parsed.length > 3) {
            parsed = parsed.slice(0, 3);
          }
          portfolioImagesJson = JSON.stringify(parsed);
        } catch (e) {
          portfolioImagesJson = JSON.stringify([]);
        }
      }

      // Auto-insert priest record into directory table to keep fully synchronized
      await dbRun(
        `INSERT INTO purohits (id, name, specialization, rating, fee, image, location, bookings_count, bio, credentials, portfolio_images, email, phone, gov_id_type, gov_id_number, gov_id_image)
         VALUES (?, ?, ?, 5.0, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, name, specialization || 'Vedic Homams', fee ? Number(fee) : 3500, image || '/images/vedic_acharya.png', targetLocation, bio || '', credentials || '', portfolioImagesJson, email, cleanPhone, govIdType || 'Aadhaar Card', govIdNumber || '', govIdImage || '/images/auth/aadhaar_mock.png']
      );

      // Insert registration payment record
      const paymentId = 'pay-' + Math.random().toString(36).substr(2, 9);
      await dbRun(`
        INSERT INTO registration_payments (id, user_id, user_name, user_email, amount, transaction_id, payment_status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [paymentId, userId, name, email, 11.0, transactionId || 'N/A', 'pending']);
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

    // Generate TOTP secret only for administrative/priest roles (never for standard users or remote artisans)
    const totp_secret = (targetRole === 'user' || targetRole === 'cottage_partner') ? null : generateBase32Secret();

    await dbRun(
      "INSERT INTO users (id, name, email, password_hash, phone, role, location, totp_secret, is_blocked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [userId, name, email, passwordHash, cleanPhone, targetRole, targetLocation, totp_secret, isBlocked]
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

    // Send Welcome Email & SMS to customer devotee
    if (targetRole === 'user' && isBlocked === 0) {
      const subject = `Welcome to the Sacred Fold of Gurupadukam, ${name}! ✦`;
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #C9943A; border-radius: 12px; max-width: 600px; background-color: #FCFBF8; margin: auto;">
          <h2 style="color: #5C0A20; text-align: center; border-bottom: 2px solid #C9943A; padding-bottom: 12px;">gurupadukam.com</h2>
          <p style="font-size: 16px; color: #1A1A1A; font-weight: bold;">Hari Om, ${name} ji!</p>
          <p style="font-size: 14px; color: #333; line-height: 1.6;">Your devotee account has been successfully created on Gurupadukam, the premier portal for Vedic rituals, pure cottage handicrafts, and spiritual consultations.</p>
          
          <div style="background-color: rgba(201,148,58,0.1); border-left: 4px solid #C9943A; padding: 15px; margin: 20px 0; border-radius: 4px;">
            <strong style="color: #5C0A20; font-size: 14px;">Your Account Profile Coordinates:</strong>
            <ul style="margin: 8px 0 0 0; padding-left: 20px; font-size: 13px; color: #555; line-height: 1.5;">
              <li><strong>Registered Email:</strong> ${email}</li>
              <li><strong>Registered Mobile:</strong> ${phone || 'Not provided'}</li>
              <li><strong>Onboarding Status:</strong> Activated & Secure 🔒</li>
            </ul>
          </div>
          
          <p style="font-size: 14px; color: #333; line-height: 1.6;">You can now book certified Vedic purohits for homams, purchase pure sandalwood and puja essentials, and access the Gurukulam study circles.</p>
          <div style="text-align: center; margin: 25px 0;">
            <a href="https://gurupadukam.com/login" style="background-color: #5C0A20; color: #FCFBF8; padding: 12px 25px; text-decoration: none; font-weight: bold; border-radius: 6px; font-size: 14px; display: inline-block;">Access Devotee Portal</a>
          </div>
          
          <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
          <p style="font-size: 11px; color: #777; text-align: center; font-style: italic;">"May the grace of the Guru guide your path in spiritual righteousness."</p>
          <p style="font-size: 9px; color: #999; text-align: center; margin-top: 10px;">© gurupadukam.com. All rights reserved.</p>
        </div>
      `;
      sendEmailNotification(email, subject, htmlContent);
      if (phone) {
        sendSMSNotification(phone, `Hari Om ${name}! Welcome to Gurupadukam. Your devotee profile is active. Book Pujas & shop pure essentials at gurupadukam.com ✦`);
      }
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

    // Verify TOTP if enabled on the devotee account (strictly active for administrative and priestly roles, not standard devotees)
    if (user.totp_secret && (user.role === 'admin' || user.role === 'super_admin' || user.role === 'purohit')) {
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
    const host = req.headers.host || '';
    const isLocal = host.includes('localhost') || host.includes('127.0.0.1');

    const { OAuth2Client } = await import('google-auth-library');
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
    
    // Fallback sandbox verify only allowed on local environment (strictly blocked in production)
    if (!process.env.GOOGLE_CLIENT_ID || idToken === 'google-oauth-devotee-idtoken') {
      if (isLocal) {
        console.log(`[Google OAuth Mock] Verifying simulated ID Token on localhost...`);
        const payload = {
          email: 'devotee.google@gmail.com',
          name: 'Google Devotee',
          sub: 'google-oauth-sub-123456789'
        };
        return handleGooglePayload(payload, res);
      } else {
        return res.status(401).json({ 
          error: 'Unauthorized', 
          message: 'Google Social Authentication coordinates are not configured on this server environment. Please contact the platform administrator. ✦' 
        });
      }
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
      const userId = await generateNextUserId('user');
      const randomPassword = await bcrypt.hash(Math.random().toString(36), 10);
      const totp_secret = null; // Google devotee login does not require Google Authenticator/TOTP

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
    <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #C9943A; border-radius: 12px; max-width: 500px; background-color: #FCFBF8; margin: auto; text-align: center;">
      <img src="https://gurupadukam.com/gurupadukam_logo.png" alt="Gurupadukam Logo" style="display: block; margin: 0 auto 15px auto; width: 80px; height: 80px; border-radius: 50%; border: 2px solid #C9943A; background-color: #fff;" />
      <h2 style="color: #5C0A20; text-align: center; border-bottom: 2px solid #C9943A; padding-bottom: 12px; margin-top: 0; font-family: 'Cinzel', Georgia, serif; letter-spacing: 2px; text-transform: uppercase; font-size: 20px;">gurupadukam.com</h2>
      <div style="text-align: left; margin-top: 20px;">
        <p style="font-size: 15px; color: #1A1A1A; font-weight: bold; margin-bottom: 8px;">Dear Devotee,</p>
        <p style="font-size: 13px; color: #333; line-height: 1.6; margin-bottom: 20px;">You requested a secure instant login. Use the 6-digit secure code below to log in or register:</p>
      </div>
      <div style="font-size: 32px; font-weight: bold; color: #5C0A20; text-align: center; background-color: rgba(201,148,58,0.1); padding: 15px; border-radius: 8px; margin: 20px 0; letter-spacing: 4px; font-family: 'Courier New', Courier, monospace; border: 1px dashed #C9943A;">
        ${code}
      </div>
      <div style="text-align: left;">
        <p style="font-size: 11px; color: #666; font-style: italic; margin-bottom: 20px;">This login code is valid for 5 minutes. For security, please do not share this code.</p>
      </div>
      <hr style="border: 0; border-top: 1px solid #eee; margin-bottom: 15px;" />
      <p style="font-size: 9px; color: #999; text-align: center; margin-top: 10px;">© ${new Date().getFullYear()} gurupadukam.com. All rights reserved.</p>
    </div>
  `;
  
  const emailSent = await sendEmailNotification(email, subject, htmlContent);
  const isMock = !emailSent || (!process.env.SENDGRID_API_KEY && !process.env.SMTP_HOST && !EMAIL_RELAY_URL);
  res.json({ 
    message: emailSent ? 'Email login verification code generated and sent successfully.' : 'Email login verification code generated (Simulation Mode).',
    debugCode: isMock ? code : undefined
  });
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
      return res.status(404).json({ error: 'Not Found', message: 'No account registered with this email. Please sign up first. ✦' });
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
  const { phone, purpose } = req.body;
  if (!phone || phone.length < 10) {
    return res.status(400).json({ error: 'Bad Request', message: 'Valid mobile number required.' });
  }

  const cleanPhone = normalizePhone(phone);
  try {
    const existing = await dbGet("SELECT * FROM users WHERE phone = ? OR phone LIKE ?", [cleanPhone, '%' + cleanPhone]);
    if (purpose === 'register' && existing) {
      return res.status(400).json({ error: 'Conflict', message: 'This mobile number is already registered. Please sign in instead. ✦' });
    }
    if (purpose === 'reset' && !existing) {
      return res.status(404).json({ error: 'Not Found', message: 'No account registered with this mobile number. Please check or sign up. ✦' });
    }
    if (purpose === 'login' && !existing) {
      return res.status(404).json({ error: 'Not Found', message: 'No account registered with this mobile number. Please sign up first. ✦' });
    }
  } catch (err) {
    console.error(`[OTP Send Validate Error]:`, err.message);
  }
  
  // Generate secure random 6-digit OTP code with 5-minute expiry
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore[cleanPhone] = { code, expiresAt: Date.now() + 5 * 60 * 1000 };

  console.log(`[SMS Service] Secure OTP ${code} dispatched to phone ${cleanPhone}`);
  const messageText = code;
  const smsSent = await sendSMSNotification(phone, messageText);

  const isMock = !smsSent || (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER);
  res.json({ 
    message: smsSent ? 'OTP code generated and sent successfully.' : 'OTP code generated (Simulation Mode).',
    debugCode: isMock ? code : undefined
  }); 
});

app.post('/api/auth/email-code/send', async (req, res) => {
  const { email, purpose } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Bad Request', message: 'Valid email address required.' });
  }

  try {
    const existing = await dbGet("SELECT * FROM users WHERE email = ?", [email]);
    if (purpose === 'register' && existing) {
      return res.status(400).json({ error: 'Conflict', message: 'This email address is already registered. Please sign in instead. ✦' });
    }
    if (purpose === 'reset' && !existing) {
      return res.status(404).json({ error: 'Not Found', message: 'No account registered with this email address. Please check or sign up. ✦' });
    }
  } catch (err) {
    console.error(`[Email Code Send Validate Error]:`, err.message);
  }

  // Generate secure random 6-digit email code with 5-minute expiry
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore[email] = { code, expiresAt: Date.now() + 5 * 60 * 1000 };

  console.log(`[Email Service] Secure verification code ${code} dispatched to email ${email}`);
  const subject = `Gurupadukam Verification Code: ${code} ✦`;
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #C9943A; border-radius: 12px; max-width: 500px; background-color: #FCFBF8; margin: auto; text-align: center;">
      <img src="https://gurupadukam.com/gurupadukam_logo.png" alt="Gurupadukam Logo" style="display: block; margin: 0 auto 15px auto; width: 80px; height: 80px; border-radius: 50%; border: 2px solid #C9943A; background-color: #fff;" />
      <h2 style="color: #5C0A20; text-align: center; border-bottom: 2px solid #C9943A; padding-bottom: 12px; margin-top: 0; font-family: 'Cinzel', Georgia, serif; letter-spacing: 2px; text-transform: uppercase; font-size: 20px;">gurupadukam.com</h2>
      <div style="text-align: left; margin-top: 20px;">
        <p style="font-size: 15px; color: #1A1A1A; font-weight: bold; margin-bottom: 8px;">Dear Devotee,</p>
        <p style="font-size: 13px; color: #333; line-height: 1.6; margin-bottom: 20px;">Your secure verification code is:</p>
      </div>
      <div style="font-size: 32px; font-weight: bold; color: #5C0A20; text-align: center; background-color: rgba(201,148,58,0.1); padding: 15px; border-radius: 8px; margin: 20px 0; letter-spacing: 4px; font-family: 'Courier New', Courier, monospace; border: 1px dashed #C9943A;">
        ${code}
      </div>
      <div style="text-align: left;">
        <p style="font-size: 11px; color: #666; font-style: italic; margin-bottom: 20px;">This verification code is valid for 5 minutes. For security, please do not share this code with anyone.</p>
      </div>
      <hr style="border: 0; border-top: 1px solid #eee; margin-bottom: 15px;" />
      <p style="font-size: 9px; color: #999; text-align: center; margin-top: 10px;">© ${new Date().getFullYear()} gurupadukam.com. All rights reserved.</p>
    </div>
  `;
  const emailSent = await sendEmailNotification(email, subject, htmlContent);

  const isMock = !emailSent || (!process.env.SENDGRID_API_KEY && !process.env.SMTP_HOST && !EMAIL_RELAY_URL);
  res.json({ 
    message: emailSent ? 'Verification code generated and sent successfully.' : 'Verification code generated (Simulation Mode).',
    debugCode: isMock ? code : undefined
  });
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

app.post('/api/auth/firebase-verify', async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) {
    return res.status(400).json({ error: 'Bad Request', message: 'Token is required.' });
  }

  try {
    const decoded = await verifyFirebaseIdToken(idToken);
    const phone = decoded.phone_number;
    if (!phone) {
      return res.status(400).json({ error: 'Unauthorized', message: 'Verification token does not contain a verified phone number.' });
    }

    const cleanPhone = normalizePhone(phone);
    let user = await dbGet("SELECT * FROM users WHERE phone = ? OR phone LIKE ?", [cleanPhone, '%' + cleanPhone]);
    
    if (user && user.is_blocked === 1) {
      const msg = (user.role === 'purohit' || user.role === 'admin' || user.role === 'cottage_partner')
        ? 'Your registration is currently pending Super-Admin validation. You will be able to access your dashboard as soon as the platform administrator activates your account. ✦'
        : 'Your account has been suspended by the platform administrator.';
      return res.status(403).json({ error: 'Forbidden', message: msg });
    }

    if (!user) {
      // Auto-register devotee user
      const userId = await generateNextUserId('user');
      const generatedPass = await bcrypt.hash(Math.random().toString(36), 10);
      const regName = 'Devotee';
      const regEmail = `${cleanPhone}@phone.user`;
      const targetRole = 'user';

      await dbRun(
        "INSERT INTO users (id, name, email, password_hash, phone, role, is_blocked) VALUES (?, ?, ?, ?, ?, ?, 0)",
        [userId, regName, regEmail, generatedPass, cleanPhone, targetRole]
      );
      user = { id: userId, name: regName, email: regEmail, role: targetRole, location: null, is_blocked: 0 };
    }

    const token = generateToken({ id: user.id, name: user.name, email: user.email, role: user.role, location: user.location });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, location: user.location, is_blocked: user.is_blocked } });
  } catch (err) {
    console.error('✦ [Firebase Login Verify Error]:', err.message);
    res.status(500).json({ error: 'Unauthorized', message: err.message || 'Firebase token verification failed.' });
  }
});

app.post('/api/auth/otp/verify', async (req, res) => {
  const { phone, otp, role, name } = req.body;
  if (!phone || !otp) {
    return res.status(400).json({ error: 'Bad Request', message: 'Phone and OTP are required.' });
  }

  const cleanPhone = normalizePhone(phone);
  // Verify expiring OTP in cache
  const record = otpStore[cleanPhone];
  if (!record || record.code !== otp || record.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'Unauthorized', message: 'Invalid or expired OTP code.' });
  }
  
  // Clear OTP once verified
  delete otpStore[cleanPhone];

  try {
    let user = await dbGet("SELECT * FROM users WHERE phone = ? OR phone LIKE ?", [cleanPhone, '%' + cleanPhone]);
    if (user && user.is_blocked === 1) {
      const msg = (user.role === 'purohit' || user.role === 'admin' || user.role === 'cottage_partner')
        ? 'Your registration is currently pending Super-Admin validation. You will be able to access your dashboard as soon as the platform administrator activates your account. ✦'
        : 'Your account has been suspended by the platform administrator.';
      return res.status(403).json({ error: 'Forbidden', message: msg });
    }

    if (!user) {
      return res.status(404).json({ error: 'Not Found', message: 'No account registered with this mobile number. Please sign up first. ✦' });
    }

    const token = generateToken({ id: user.id, name: user.name, email: user.email, role: user.role, location: user.location });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, location: user.location, is_blocked: user.is_blocked } });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// Secure Token-Based Forgot Password Endpoint (Zero-Cost Recovery Links)
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Bad Request', message: 'Valid email address required.' });
  }

  try {
    const user = await dbGet("SELECT * FROM users WHERE email = ?", [email]);
    if (!user) {
      // Return a successful generic message to prevent user enumeration
      return res.json({ 
        message: 'If this email address is registered, a secure recovery link has been dispatched to it.' 
      });
    }

    // Generate high-entropy 32-byte token
    const token = crypto.randomBytes(32).toString('hex');
    resetTokenStore[token] = { email, expiresAt: Date.now() + 60 * 60 * 1000 }; // 1 hour expiry

    let origin = req.headers.origin;
    if (!origin && req.headers.referer) {
      try {
        const refUrl = new URL(req.headers.referer);
        origin = refUrl.origin;
      } catch (e) {}
    }
    const host = req.headers.host || '';
    const isLocal = host.includes('localhost') || host.includes('127.0.0.1') || (origin && (origin.includes('localhost') || origin.includes('127.0.0.1')));
    
    if (!origin) {
      if (isLocal) {
        origin = host.startsWith('http') ? host : `http://${host}`;
      } else {
        origin = 'https://gurupadukam.com';
      }
    }
    if (!origin.startsWith('http://') && !origin.startsWith('https://')) {
      origin = (isLocal ? 'http://' : 'https://') + origin;
    }
    const resetLink = `${origin}/reset-password?token=${token}&email=${encodeURIComponent(email)}`;

    console.log(`[Forgot Password] Secure reset link generated for ${email}: ${resetLink}`);

    const subject = `✦ Gurupadukam Password Recovery Desk ✦`;
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #C9943A; border-radius: 12px; max-width: 600px; background-color: #FCFBF8; margin: auto;">
        <h2 style="color: #5C0A20; text-align: center; border-bottom: 2px solid #C9943A; padding-bottom: 12px;">gurupadukam.com</h2>
        <p style="font-size: 16px; color: #1A1A1A; font-weight: bold;">Hari Om, ${user.name || 'Devotee'} ji!</p>
        <p style="font-size: 14px; color: #333; line-height: 1.6;">We received a request to recover the credentials for your Gurupadukam account. To proceed, please click the secure button below to set a new password:</p>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetLink}" style="background-color: #5C0A20; color: #FCFBF8; padding: 12px 30px; text-decoration: none; font-weight: bold; border-radius: 6px; font-size: 14px; display: inline-block; border: 1px solid #C9943A; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">Reset My Password</a>
        </div>
        
        <p style="font-size: 13px; color: #555; line-height: 1.5; text-align: center;">
          If the button does not work, you can copy and paste the following link into your browser:
          <br />
          <a href="${resetLink}" style="color: #5C0A20; word-break: break-all; font-size: 11px;">${resetLink}</a>
        </p>

        <p style="font-size: 12px; color: #666; font-style: italic; margin-top: 25px; border-top: 1px solid #eee; padding-top: 15px;">
          This password reset link is valid for **1 hour** for security. If you did not request this reset, you can safely ignore this email; your credentials remain perfectly secure.
        </p>
        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="font-size: 9px; color: #999; text-align: center;">© gurupadukam.com. All rights reserved.</p>
      </div>
    `;

    const emailSent = await sendEmailNotification(email, subject, htmlContent);
    const isMock = !emailSent || (!process.env.SENDGRID_API_KEY && !process.env.SMTP_HOST && !EMAIL_RELAY_URL);

    res.json({ 
      message: emailSent 
        ? 'A secure password recovery link has been dispatched to your email address.' 
        : 'A secure password recovery link was generated (Simulation Mode).',
      debugLink: isMock ? resetLink : undefined
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// Secure Token-Based Confirm Reset Endpoint
app.post('/api/auth/reset-password-confirm', async (req, res) => {
  const { email, token, newPassword } = req.body;

  if (!email || !token || !newPassword) {
    return res.status(400).json({ error: 'Bad Request', message: 'Email, secure token, and new password are required.' });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Bad Request', message: 'Password must be at least 8 characters long.' });
  }

  const complexityRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
  if (!complexityRegex.test(newPassword)) {
    return res.status(400).json({ 
      error: 'Bad Request', 
      message: 'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character (@$!%*?&).' 
    });
  }

  try {
    const record = resetTokenStore[token];
    if (!record || record.email.toLowerCase() !== email.toLowerCase() || record.expiresAt < Date.now()) {
      return res.status(400).json({ error: 'Invalid Token', message: 'The password reset link is invalid or has expired.' });
    }

    const user = await dbGet("SELECT * FROM users WHERE email = ?", [email]);
    if (!user) {
      return res.status(404).json({ error: 'Not Found', message: 'No registered account found matching this email.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await dbRun("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, user.id]);

    delete resetTokenStore[token];

    if (loginAttempts[email]) {
      delete loginAttempts[email];
    }

    res.json({ message: 'Password reset successfully. You can now log in with your new password. ✦' });
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
      const cleanPhone = normalizePhone(phone);
      user = await dbGet("SELECT * FROM users WHERE phone = ? OR phone LIKE ?", [cleanPhone, '%' + cleanPhone]);
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
      const cleanPhone = normalizePhone(phone);
      const phoneRecord = otpStore[cleanPhone];
      if (!phoneRecord || phoneRecord.code !== otp || phoneRecord.expiresAt < Date.now()) {
        return res.status(400).json({ error: 'MFA Failed', message: 'Invalid or expired Phone SMS OTP.' });
      }

      // Verify that user matches both coordinates
      if (user.email !== email || normalizePhone(user.phone) !== cleanPhone) {
        return res.status(400).json({ error: 'MFA Failed', message: 'Security conflict: Provided email and phone coordinates do not match this account.' });
      }

      // Clear codes
      delete otpStore[email];
      delete otpStore[cleanPhone];

    } else {
      // Devotee (standard user): Verify either email OR phone
      if (email && emailCode) {
        const record = otpStore[email];
        if (!record || record.code !== emailCode || record.expiresAt < Date.now()) {
          return res.status(400).json({ error: 'Verification Failed', message: 'Invalid or expired Email verification code.' });
        }
        delete otpStore[email];
      } else if (phone && otp) {
        const cleanPhone = normalizePhone(phone);
        const record = otpStore[cleanPhone];
        if (!record || record.code !== otp || record.expiresAt < Date.now()) {
          return res.status(400).json({ error: 'Verification Failed', message: 'Invalid or expired Phone SMS OTP.' });
        }
        delete otpStore[cleanPhone];
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

app.post('/api/auth/profile/update', authenticateToken, async (req, res) => {
  const { name, phone, location, password, emailCode, otp, communication_preferences } = req.body;

  try {
    const user = await dbGet("SELECT * FROM users WHERE id = ?", [req.user.id]);
    if (!user) {
      return res.status(404).json({ error: 'Not Found', message: 'User profile not found.' });
    }

    // A. OTP Verification (optional, if changing credentials or adding security check)
    if (emailCode) {
      const record = otpStore[user.email];
      if (!record || record.code !== emailCode || record.expiresAt < Date.now()) {
        return res.status(400).json({ error: 'Verification Failed', message: 'Invalid or expired Email verification code.' });
      }
      delete otpStore[user.email];
    }

    if (otp && phone) {
      const cleanPhone = normalizePhone(phone);
      const record = otpStore[cleanPhone];
      if (!record || record.code !== otp || record.expiresAt < Date.now()) {
        return res.status(400).json({ error: 'Verification Failed', message: 'Invalid or expired Phone SMS OTP.' });
      }
      delete otpStore[cleanPhone];
    }

    // B. Compile and Execute Updates
    const cleanPhone = phone ? normalizePhone(phone) : user.phone;
    let query = "UPDATE users SET name = ?, phone = ?, location = ?, communication_preferences = ?";
    let params = [name || user.name, cleanPhone, location || user.location, communication_preferences ? JSON.stringify(communication_preferences) : user.communication_preferences];

    if (password) {
      if (password.length < 8) {
        return res.status(400).json({ error: 'Bad Request', message: 'Password must be at least 8 characters long.' });
      }
      const complexityRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
      if (!complexityRegex.test(password)) {
        return res.status(400).json({ 
          error: 'Bad Request', 
          message: 'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character (@$!%*?&).' 
        });
      }
      const hashed = await bcrypt.hash(password, 10);
      query += ", password_hash = ?";
      params.push(hashed);
    }

    query += " WHERE id = ?";
    params.push(req.user.id);

    await dbRun(query, params);

    const updatedUser = await dbGet("SELECT id, name, email, phone, role, location, is_blocked FROM users WHERE id = ?", [req.user.id]);
    res.json({ message: 'Profile updated successfully! ✦', user: updatedUser });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// Devotee apply to become Acharya
app.post('/api/auth/profile/apply-purohit', authenticateToken, async (req, res) => {
  const {
    specialization,
    fee,
    bio,
    credentials,
    gov_id_type,
    gov_id_number,
    gov_id_image,
    image,
    location,
    phone,
    email,
    transactionId
  } = req.body;

  try {
    const user = await dbGet("SELECT * FROM users WHERE id = ?", [req.user.id]);
    if (!user) {
      return res.status(404).json({ error: 'Not Found', message: 'User profile not found.' });
    }

    const cleanPhone = phone ? normalizePhone(phone) : (user.phone || '');
    const cleanEmail = email || user.email || '';
    
    const existingPurohit = await dbGet("SELECT * FROM purohits WHERE id = ?", [req.user.id]);
    const targetLocation = location || user.location || 'Hyderabad';
    
    if (existingPurohit) {
      await dbRun(
        `UPDATE purohits SET 
          name = ?, specialization = ?, fee = ?, image = ?, location = ?, 
          bio = ?, credentials = ?, email = ?, phone = ?, 
          gov_id_type = ?, gov_id_number = ?, gov_id_image = ?
         WHERE id = ?`,
        [
          user.name,
          specialization || 'Vedic Homams',
          fee ? Number(fee) : 3500,
          image || '/images/vedic_acharya.png',
          targetLocation,
          bio || '',
          credentials || '',
          cleanEmail,
          cleanPhone,
          gov_id_type || 'Aadhaar Card',
          gov_id_number || '',
          gov_id_image || '/images/auth/aadhaar_mock.png',
          req.user.id
        ]
      );
    } else {
      await dbRun(
        `INSERT INTO purohits (id, name, specialization, rating, fee, image, location, bookings_count, bio, credentials, email, phone, gov_id_type, gov_id_number, gov_id_image)
         VALUES (?, ?, ?, 5.0, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.user.id,
          user.name,
          specialization || 'Vedic Homams',
          fee ? Number(fee) : 3500,
          image || '/images/vedic_acharya.png',
          targetLocation,
          bio || '',
          credentials || '',
          cleanEmail,
          cleanPhone,
          gov_id_type || 'Aadhaar Card',
          gov_id_number || '',
          gov_id_image || '/images/auth/aadhaar_mock.png'
        ]
      );
    }

    // Insert registration payment record for ₹11.0 Dakshina
    const paymentId = 'pay-' + Math.random().toString(36).substr(2, 9);
    await dbRun(`
      INSERT INTO registration_payments (id, user_id, user_name, user_email, amount, transaction_id, payment_status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [paymentId, req.user.id, user.name, cleanEmail, 11.0, transactionId || 'N/A', 'pending']);

    res.json({ message: 'Your Acharya application has been submitted successfully for verification! ✦' });
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


// --- 2.5 Product Reviews APIs ---

app.get('/api/products/:id/reviews', async (req, res) => {
  try {
    const reviews = await dbQuery("SELECT * FROM product_reviews WHERE product_id = ? ORDER BY created_at DESC", [req.params.id]);
    res.json(reviews);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.get('/api/products/:id/verify-purchase', authenticateToken, async (req, res) => {
  try {
    const order = await dbGet(
      `SELECT 1 FROM orders o 
       JOIN order_items oi ON o.id = oi.order_id 
       WHERE o.user_id = ? AND oi.product_id = ? 
       LIMIT 1`,
      [req.user.id, req.params.id]
    );
    res.json({ verifiedBuyer: !!order });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/products/:id/reviews', authenticateToken, async (req, res) => {
  const { rating, reviewText } = req.body;
  const productId = req.params.id;

  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Bad Request', message: 'Rating between 1 and 5 is required.' });
  }

  try {
    // Check if purchased
    const order = await dbGet(
      `SELECT 1 FROM orders o 
       JOIN order_items oi ON o.id = oi.order_id 
       WHERE o.user_id = ? AND oi.product_id = ? 
       LIMIT 1`,
      [req.user.id, productId]
    );

    if (!order) {
      return res.status(403).json({ error: 'Forbidden', message: 'Only verified buyers can review this product.' });
    }

    const reviewId = 'rev-' + Math.random().toString(36).substr(2, 9);
    await dbRun(
      `INSERT INTO product_reviews (id, product_id, user_id, user_name, rating, review_text)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [reviewId, productId, req.user.id, req.user.name, Number(rating), reviewText || '']
    );

    res.status(201).json({ message: 'Review posted successfully!', reviewId });
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

// Dynamic Shipping Calculator API
app.post('/api/shipping/calculate', async (req, res) => {
  const { cartItems, pincode, latitude, longitude, address } = req.body;
  if (!cartItems || cartItems.length === 0) {
    return res.status(400).json({ error: 'Bad Request', message: 'Cart is empty.' });
  }

  try {
    let weightGrams = 0;
    cartItems.forEach(item => {
      weightGrams += (item.weightGrams || 500) * item.quantity;
    });

    const subtotal = cartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    let shippingCost = 0;
    let estimatedDays = '3-5 Business Days';

    // Free shipping threshold aligned at ₹499
    if (subtotal >= 499) {
      shippingCost = 0;
      estimatedDays = '3-5 Business Days';
    } else {
      let isLocal = false;

      // 1. Calculate distance from JNTUH Metro Station (17.5008, 78.3812) if coordinates provided
      if (latitude !== undefined && longitude !== undefined && latitude !== null && longitude !== null) {
        const lat1 = Number(latitude);
        const lon1 = Number(longitude);
        const lat2 = 17.5008;
        const lon2 = 78.3812;

        const R = 6371; // Radius of the earth in km
        const dLat = (lat2 - lat1) * (Math.PI / 180);
        const dLon = (lon2 - lon1) * (Math.PI / 180);
        const a =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
          Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distance = R * c; // Distance in km

        if (distance <= 15) {
          isLocal = true;
        }
      }

      // 2. Fallback to keyword matching in address string
      if (!isLocal && address) {
        const addrLower = String(address).toLowerCase();
        const localKeywords = ['hyderabad', 'kukatpally', 'jntu', 'kphb', 'miyapur', 'nizampet', 'bachupally', 'pragathi nagar', 'chanda nagar', 'madhapur', 'gachibowli', 'hitech city'];
        isLocal = localKeywords.some(keyword => addrLower.includes(keyword));
      }

      // 3. Fallback to pincode ranges for Hyderabad/Secunderabad (500xxx)
      if (!isLocal && pincode) {
        const pinStr = pincode.toString();
        if (pinStr.startsWith('500')) {
          isLocal = true;
        }
      }

      if (isLocal) {
        shippingCost = 29;
        estimatedDays = '1 Day Express Delivery';
      } else {
        shippingCost = 39;
        estimatedDays = '3-5 Business Days';
      }
    }

    res.json({
      success: true,
      cost: shippingCost,
      estimatedDelivery: estimatedDays,
      weightGrams
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: 'Failed to calculate shipping.' });
  }
});

async function triggerOrderPlacedNotification(orderId, customerName, customerEmail, customerPhone, shippingAddress, items, total, paymentMethod) {
  try {
    const receiptSubject = `✦ Order Placed: ${orderId} – Gurupadukam Store 🌿`;
    
    // Parse address
    let parsedAddress = shippingAddress;
    if (typeof shippingAddress === 'string') {
      try { parsedAddress = JSON.parse(shippingAddress); } catch (e) {}
    }
    const addressStr = `${parsedAddress.addressLine || parsedAddress.address || ''}, ${parsedAddress.city || ''}, ${parsedAddress.state || ''} - ${parsedAddress.pincode || parsedAddress.zip || ''}`;

    let itemsHtml = '';
    for (const item of items) {
      const name = item.name || item.product_name;
      const quantity = item.quantity || item.units || 1;
      const price = item.price || item.selling_price;
      itemsHtml += `
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #eee; font-size: 13px;">${name}</td>
          <td style="padding: 10px; border-bottom: 1px solid #eee; font-size: 13px; text-align: center;">${quantity}</td>
          <td style="padding: 10px; border-bottom: 1px solid #eee; font-size: 13px; text-align: right;">₹${price}</td>
          <td style="padding: 10px; border-bottom: 1px solid #eee; font-size: 13px; text-align: right;">₹${price * quantity}</td>
        </tr>
      `;
    }

    const receiptHtml = `
      <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #C9943A; border-radius: 12px; max-width: 600px; background-color: #FCFBF8; margin: auto;">
        <h2 style="color: #5C0A20; text-align: center; border-bottom: 2px solid #C9943A; padding-bottom: 12px; margin-top: 0;">gurupadukam.com</h2>
        <p style="font-size: 15px; color: #1A1A1A; font-weight: bold;">Hari Om, ${customerName} ji!</p>
        <p style="font-size: 13px; color: #333; line-height: 1.5;">Thank you for your order! Your order has been successfully placed and is pending verification. Once the payment has been validated, we will confirm your order, dispatch your package, and send you a confirmation email.</p>
        
        <div style="margin: 20px 0; background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; padding: 15px; font-size: 12px; line-height: 1.6;">
          <strong style="color: #5C0A20; font-size: 13px; display: block; border-bottom: 1px solid #eee; padding-bottom: 5px; margin-bottom: 8px;">Order Details:</strong>
          <strong>Order ID:</strong> ${orderId}<br>
          <strong>Date:</strong> ${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}<br>
          <strong>Payment Method:</strong> ${paymentMethod}<br>
          <strong>Payment Status:</strong> Pending Verification<br>
          <strong>Logistics Status:</strong> Awaiting Payment Confirmation 🚚
        </div>

        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <thead>
            <tr style="background-color: rgba(201,148,58,0.1); color: #5C0A20;">
              <th style="padding: 10px; text-align: left; font-size: 12px; font-weight: bold; border-bottom: 2px solid #C9943A;">Item</th>
              <th style="padding: 10px; text-align: center; font-size: 12px; font-weight: bold; border-bottom: 2px solid #C9943A;">Qty</th>
              <th style="padding: 10px; text-align: right; font-size: 12px; font-weight: bold; border-bottom: 2px solid #C9943A;">Price</th>
              <th style="padding: 10px; text-align: right; font-size: 12px; font-weight: bold; border-bottom: 2px solid #C9943A;">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
            <tr style="font-weight: bold; color: #5C0A20; background: rgba(201,148,58,0.05);">
              <td colspan="3" style="padding: 12px 10px; text-align: right; font-size: 13px; border-top: 2px solid #C9943A;">Grand Total:</td>
              <td style="padding: 12px 10px; text-align: right; font-size: 14px; border-top: 2px solid #C9943A;">₹${total}</td>
            </tr>
          </tbody>
        </table>

        <div style="margin: 20px 0; background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; padding: 15px; font-size: 12px; line-height: 1.6;">
          <strong style="color: #5C0A20; font-size: 13px; display: block; border-bottom: 1px solid #eee; padding-bottom: 5px; margin-bottom: 8px;">Delivery Coordinates:</strong>
          <strong>Recipient Name:</strong> ${customerName}<br>
          <strong>Phone:</strong> ${customerPhone}<br>
          <strong>Address:</strong> ${addressStr}
        </div>

        <p style="font-size: 13px; color: #333; line-height: 1.5;">You can track your order status in your Devotee dashboard. If you have any questions, feel free to contact us.</p>
        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="font-size: 9px; color: #999; text-align: center; margin-top: 10px;">Thank you for supporting our cottage artisans! © gurupadukam.com. All rights reserved.</p>
      </div>
    `;

    await sendEmailNotification(customerEmail, receiptSubject, receiptHtml);
    await sendSMSNotification(customerPhone, `Hari Om! Order ${orderId} has been successfully placed for ₹${total} via ${paymentMethod}. Payment verification pending. ✦`);
    await sendWhatsAppNotification(customerPhone, `Hari Om! Order ${orderId} has been successfully placed for ₹${total} via ${paymentMethod}. Payment verification pending. ✦`);
  } catch (notifErr) {
    console.error('[Notification Dispatch Failed on Order Placed]:', notifErr.message);
  }
}

async function triggerOrderConfirmedNotification(orderId, customerName, customerEmail, customerPhone, shippingAddress, items, total, paymentMethod, awbCode) {
  try {
    const receiptSubject = `✦ Order Confirmed: ${orderId} – Gurupadukam Store 🌿`;
    
    // Parse address
    let parsedAddress = shippingAddress;
    if (typeof shippingAddress === 'string') {
      try { parsedAddress = JSON.parse(shippingAddress); } catch (e) {}
    }
    const addressStr = `${parsedAddress.addressLine || parsedAddress.address || ''}, ${parsedAddress.city || ''}, ${parsedAddress.state || ''} - ${parsedAddress.pincode || parsedAddress.zip || ''}`;

    let itemsHtml = '';
    for (const item of items) {
      const name = item.name || item.product_name;
      const quantity = item.quantity || item.units || 1;
      const price = item.price || item.selling_price;
      itemsHtml += `
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #eee; font-size: 13px;">${name}</td>
          <td style="padding: 10px; border-bottom: 1px solid #eee; font-size: 13px; text-align: center;">${quantity}</td>
          <td style="padding: 10px; border-bottom: 1px solid #eee; font-size: 13px; text-align: right;">₹${price}</td>
          <td style="padding: 10px; border-bottom: 1px solid #eee; font-size: 13px; text-align: right;">₹${price * quantity}</td>
        </tr>
      `;
    }

    const receiptHtml = `
      <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #C9943A; border-radius: 12px; max-width: 600px; background-color: #FCFBF8; margin: auto;">
        <h2 style="color: #5C0A20; text-align: center; border-bottom: 2px solid #C9943A; padding-bottom: 12px; margin-top: 0;">gurupadukam.com</h2>
        <p style="font-size: 15px; color: #1A1A1A; font-weight: bold;">Hari Om, ${customerName} ji!</p>
        <p style="font-size: 13px; color: #333; line-height: 1.5;">Thank you for your order! Your payment and cart coordinates have been verified. We have successfully registered your shipment with our courier partner.</p>
        
        <div style="margin: 20px 0; background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; padding: 15px; font-size: 12px; line-height: 1.6;">
          <strong style="color: #5C0A20; font-size: 13px; display: block; border-bottom: 1px solid #eee; padding-bottom: 5px; margin-bottom: 8px;">Order Details:</strong>
          <strong>Order ID:</strong> ${orderId}<br>
          <strong>Date:</strong> ${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}<br>
          <strong>Payment Method:</strong> ${paymentMethod} (Paid)<br>
          <strong>Logistics Status:</strong> Registered on Shiprocket 🚚<br>
          <strong>AWB Number:</strong> ${awbCode || 'Pending Dispatch'}
        </div>

        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <thead>
            <tr style="background-color: rgba(201,148,58,0.1); color: #5C0A20;">
              <th style="padding: 10px; text-align: left; font-size: 12px; font-weight: bold; border-bottom: 2px solid #C9943A;">Item</th>
              <th style="padding: 10px; text-align: center; font-size: 12px; font-weight: bold; border-bottom: 2px solid #C9943A;">Qty</th>
              <th style="padding: 10px; text-align: right; font-size: 12px; font-weight: bold; border-bottom: 2px solid #C9943A;">Price</th>
              <th style="padding: 10px; text-align: right; font-size: 12px; font-weight: bold; border-bottom: 2px solid #C9943A;">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
            <tr style="font-weight: bold; color: #5C0A20; background: rgba(201,148,58,0.05);">
              <td colspan="3" style="padding: 12px 10px; text-align: right; font-size: 13px; border-top: 2px solid #C9943A;">Grand Total:</td>
              <td style="padding: 12px 10px; text-align: right; font-size: 14px; border-top: 2px solid #C9943A;">₹${total}</td>
            </tr>
          </tbody>
        </table>

        <div style="margin: 20px 0; background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; padding: 15px; font-size: 12px; line-height: 1.6;">
          <strong style="color: #5C0A20; font-size: 13px; display: block; border-bottom: 1px solid #eee; padding-bottom: 5px; margin-bottom: 8px;">Delivery Coordinates:</strong>
          <strong>Recipient Name:</strong> ${customerName}<br>
          <strong>Phone:</strong> ${customerPhone}<br>
          <strong>Address:</strong> ${addressStr}
        </div>

        <p style="font-size: 13px; color: #333; line-height: 1.5;">You will receive live SMS updates once your package is picked up by the logistics hub. Feel free to track your shipment in your Devotee dashboard.</p>
        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="font-size: 9px; color: #999; text-align: center; margin-top: 10px;">Thank you for supporting our cottage artisans! © gurupadukam.com. All rights reserved.</p>
      </div>
    `;

    await sendEmailNotification(customerEmail, receiptSubject, receiptHtml);
    await sendSMSNotification(customerPhone, `Hari Om! Order ${orderId} confirmed for ₹${total}. Shipped via Shiprocket (AWB: ${awbCode || 'Pending'}). Track details at gurupadukam.com ✦`);
    await sendWhatsAppNotification(customerPhone, `Hari Om! Order ${orderId} confirmed for ₹${total}. Shipped via Shiprocket (AWB: ${awbCode || 'Pending'}). Track details at gurupadukam.com ✦`);
  } catch (notifErr) {
    console.error('[Notification Dispatch Failed on Order Confirmed]:', notifErr.message);
  }
}

async function triggerOrderCancelledNotification(orderId, customerName, customerEmail, customerPhone, reason) {
  try {
    const subject = `✦ Order Cancelled: ${orderId} – Gurupadukam Store 🌿`;
    const cancelReason = reason || "Payment Verification Failed / Unsuccessful";
    
    const receiptHtml = `
      <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #5C0A20; border-radius: 12px; max-width: 600px; background-color: #FCFBF8; margin: auto;">
        <h2 style="color: #5C0A20; text-align: center; border-bottom: 2px solid #5C0A20; padding-bottom: 12px; margin-top: 0;">gurupadukam.com</h2>
        <p style="font-size: 15px; color: #1A1A1A; font-weight: bold;">Hari Om, ${customerName} ji!</p>
        <p style="font-size: 13px; color: #333; line-height: 1.5;">We regret to inform you that your order <strong>${orderId}</strong> has been cancelled.</p>
        
        <div style="margin: 20px 0; background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; padding: 15px; font-size: 12px; line-height: 1.6;">
          <strong style="color: #5C0A20; font-size: 13px; display: block; border-bottom: 1px solid #eee; padding-bottom: 5px; margin-bottom: 8px;">Cancellation Details:</strong>
          <strong>Order ID:</strong> ${orderId}<br>
          <strong>Reason:</strong> ${cancelReason}<br>
          <strong>Status:</strong> Cancelled / Payment Unsuccessful ❌
        </div>
        <p style="font-size: 11px; color: #666; text-align: center;">If you believe this is an error or wish to retry, please contact Gurupadukam Support or place a new order.</p>
      </div>
    `;

    await sendEmailNotification(customerEmail, subject, receiptHtml);
    await sendSMSNotification(customerPhone, `Hari Om! Your order ${orderId} has been cancelled. Reason: ${cancelReason}. Contact support for help. ✦`);
    await sendWhatsAppNotification(customerPhone, `Hari Om! Your order ${orderId} has been cancelled. Reason: ${cancelReason}. Contact support for help. ✦`);
  } catch (err) {
    console.error('[Cancellation Notification Failed]:', err.message);
  }
}

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
    const orderCountRow = await dbGet("SELECT COUNT(*) as count FROM orders WHERE id LIKE 'INV-%'");
    let orderIndex = (orderCountRow?.count || 0) + 1;
    let orderId = `INV-${orderIndex}`;
    while (await dbGet("SELECT id FROM orders WHERE id = ?", [orderId])) {
      orderIndex++;
      orderId = `INV-${orderIndex}`;
    }
    const paymentStatus = (paymentMethod === 'Cash on Delivery' || paymentMethod === 'Direct UPI (QR Code)') ? 'payment-pending' : 'paid';

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

    // 5. Build order response (Shiprocket creation is deferred until manual admin Handover)
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
      shiprocketShipmentId: null,
      shiprocketAwb: null,
      status: 'Processing',
      date: new Date().toISOString()
    };

    // Send notifications based on initial payment state
    if (paymentStatus === 'paid') {
      await triggerOrderConfirmedNotification(orderId, customerName, customerEmail, customerPhone, shippingAddress, cartItems, total, paymentMethod, null);
    } else {
      await triggerOrderPlacedNotification(orderId, customerName, customerEmail, customerPhone, shippingAddress, cartItems, total, paymentMethod);
    }

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
  const { status, reason } = req.body;
  if (!status) {
    return res.status(400).json({ error: 'Bad Request', message: 'Status parameter required.' });
  }

  try {
    const existing = await dbGet("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: 'Not Found', message: 'Order not found.' });
    }

    await dbRun("UPDATE orders SET status = ? WHERE id = ?", [status, req.params.id]);

    // Send cancellation email/SMS/WhatsApp if status is updated to Cancelled
    if (status === 'Cancelled') {
      await triggerOrderCancelledNotification(
        existing.id,
        existing.customer_name,
        existing.customer_email,
        existing.customer_phone,
        reason
      );
    }

    res.json({ message: 'Order shipment status updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.put('/api/orders/:id/payment-status', authenticateToken, requireAdminOrSuper, async (req, res) => {
  const { paymentStatus } = req.body;
  if (!paymentStatus) {
    return res.status(400).json({ error: 'Bad Request', message: 'Payment status parameter required.' });
  }

  try {
    const existing = await dbGet("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: 'Not Found', message: 'Order not found.' });
    }

    await dbRun("UPDATE orders SET payment_status = ? WHERE id = ?", [paymentStatus, req.params.id]);

    // Send confirmation notifications if status transitions to 'paid' from something else
    if (existing.payment_status !== 'paid' && paymentStatus === 'paid') {
      const items = await dbQuery("SELECT * FROM order_items WHERE order_id = ?", [existing.id]);
      await triggerOrderConfirmedNotification(
        existing.id,
        existing.customer_name,
        existing.customer_email,
        existing.customer_phone,
        existing.shipping_address,
        items,
        existing.total,
        existing.payment_method,
        existing.shiprocket_awb
      );
    }

    res.json({ message: 'Order payment status updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/orders/:id/handover', authenticateToken, requireAdminOrSuper, async (req, res) => {
  const { type } = req.body;
  if (!type) {
    return res.status(400).json({ error: 'Bad Request', message: 'Handover type parameter required (self or shiprocket).' });
  }

  try {
    const order = await dbGet("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    if (!order) {
      return res.status(404).json({ error: 'Not Found', message: 'Order not found.' });
    }

    if (order.shiprocket_awb) {
      return res.status(400).json({ error: 'Bad Request', message: 'Order is already handed over.' });
    }

    const items = await dbQuery("SELECT * FROM order_items WHERE order_id = ?", [order.id]);

    if (type === 'self') {
      const selfAwb = 'GP-SELF-' + Math.floor(100000 + Math.random() * 900000);
      await dbRun(
        `UPDATE orders SET shiprocket_shipment_id = ?, shiprocket_awb = ?, status = 'Out for Delivery' WHERE id = ?`,
        ['Self-Delivery', selfAwb, order.id]
      );

      // Send dispatch notification
      try {
        const subject = `✦ Order Dispatched: Local Self-Delivery – ${order.id} 🌿`;
        let parsedAddress = order.shipping_address;
        if (typeof parsedAddress === 'string') {
          try { parsedAddress = JSON.parse(parsedAddress); } catch (e) {}
        }
        const addressStr = `${parsedAddress.addressLine || parsedAddress.address || ''}, ${parsedAddress.city || ''}, ${parsedAddress.state || ''} - ${parsedAddress.pincode || parsedAddress.zip || ''}`;

        const notificationHtml = `
          <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #C9943A; border-radius: 12px; max-width: 600px; background-color: #FCFBF8; margin: auto;">
            <h2 style="color: #5C0A20; text-align: center; border-bottom: 2px solid #C9943A; padding-bottom: 12px; margin-top: 0;">gurupadukam.com</h2>
            <p style="font-size: 15px; color: #1A1A1A; font-weight: bold;">Hari Om, ${order.customer_name} ji!</p>
            <p style="font-size: 13px; color: #333; line-height: 1.5;">Your sacred order has been handed over for <strong>Local Self-Delivery</strong>! A Gurupadukam Sewak will personally deliver the packages directly to your doorstep shortly.</p>
            
            <div style="margin: 20px 0; background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; padding: 15px; font-size: 12px; line-height: 1.6;">
              <strong>Delivery Coordinates:</strong><br>
              <strong>Recipient:</strong> ${order.customer_name}<br>
              <strong>Address:</strong> ${addressStr}<br>
              <strong>Fulfillment Mode:</strong> Local Handover (Self-Delivery) 🚚<br>
              <strong>AWB Code:</strong> ${selfAwb}
            </div>
            <p style="font-size: 11px; color: #666; text-align: center;">Our sewa team will contact you on call upon arrival. Thank you for your support!</p>
          </div>
        `;
        
        await sendEmailNotification(order.customer_email, subject, notificationHtml);
        await sendSMSNotification(order.customer_phone, `Hari Om! Your order ${order.id} has been handed over for local self-delivery. A Gurupadukam Sewak will deliver it shortly. ✦`);
        await sendWhatsAppNotification(order.customer_phone, `Hari Om! Your order ${order.id} has been handed over for local self-delivery. A Gurupadukam Sewak will deliver it shortly. ✦`);
      } catch (err) {
        console.error('[Handover Email Failed]:', err.message);
      }

      return res.json({ success: true, message: 'Local Self-Delivery registered successfully.', status: 'Out for Delivery', awb: selfAwb });
    } else if (type === 'shiprocket') {
      // Create Shiprocket Shipment
      const fullOrderData = {
        id: order.id,
        customer_name: order.customer_name,
        customer_email: order.customer_email,
        customer_phone: order.customer_phone,
        shipping_address: order.shipping_address,
        total: order.total,
        payment_method: order.payment_method,
        items: items,
        date: order.date
      };

      const shipment = await createShiprocketShipment(fullOrderData);

      await dbRun(
        `UPDATE orders SET shiprocket_shipment_id = ?, shiprocket_awb = ? WHERE id = ?`,
        [shipment.shipment_id, shipment.awb_code, order.id]
      );

      // Send dispatch notification
      try {
        const subject = `✦ Order Shipped: Handed Over to Gateway – ${order.id} 🌿`;
        let parsedAddress = order.shipping_address;
        if (typeof parsedAddress === 'string') {
          try { parsedAddress = JSON.parse(parsedAddress); } catch (e) {}
        }
        const addressStr = `${parsedAddress.addressLine || parsedAddress.address || ''}, ${parsedAddress.city || ''}, ${parsedAddress.state || ''} - ${parsedAddress.pincode || parsedAddress.zip || ''}`;

        const notificationHtml = `
          <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #C9943A; border-radius: 12px; max-width: 600px; background-color: #FCFBF8; margin: auto;">
            <h2 style="color: #5C0A20; text-align: center; border-bottom: 2px solid #C9943A; padding-bottom: 12px; margin-top: 0;">gurupadukam.com</h2>
            <p style="font-size: 15px; color: #1A1A1A; font-weight: bold;">Hari Om, ${order.customer_name} ji!</p>
            <p style="font-size: 13px; color: #333; line-height: 1.5;">Your sacred order has been successfully handed over to our logistics partner!</p>
            
            <div style="margin: 20px 0; background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; padding: 15px; font-size: 12px; line-height: 1.6;">
              <strong>Logistics Coordinates:</strong><br>
              <strong>Recipient:</strong> ${order.customer_name}<br>
              <strong>Address:</strong> ${addressStr}<br>
              <strong>Carrier:</strong> Delhivery (via Shiprocket)<br>
              <strong>AWB Code:</strong> ${shipment.awb_code || 'Pending'}<br>
              <strong>Fulfillment Mode:</strong> Shipping Gateway 🚚
            </div>
            <p style="font-size: 11px; color: #666; text-align: center;">You will receive live tracking updates via SMS as the shipment moves. Thank you!</p>
          </div>
        `;
        
        await sendEmailNotification(order.customer_email, subject, notificationHtml);
        await sendSMSNotification(order.customer_phone, `Hari Om! Your order ${order.id} has been handed over to Shiprocket (AWB: ${shipment.awb_code}). Track at gurupadukam.com ✦`);
        await sendWhatsAppNotification(order.customer_phone, `Hari Om! Your order ${order.id} has been handed over to Shiprocket (AWB: ${shipment.awb_code}). Track at gurupadukam.com ✦`);
      } catch (err) {
        console.error('[Handover Email Failed]:', err.message);
      }

      return res.json({ success: true, message: 'Shipment handed over to gateway successfully.', status: 'Shipped', awb: shipment.awb_code });
    } else {
      return res.status(400).json({ error: 'Bad Request', message: 'Invalid handover type.' });
    }
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

app.get('/api/admin/purohits/pending', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const pending = await dbQuery(`
      SELECT u.id, u.name, u.email, u.phone, u.location, p.specialization, p.fee, p.bio, p.credentials, p.gov_id_type, p.gov_id_number, p.gov_id_image
      FROM users u
      JOIN purohits p ON u.id = p.id
      WHERE u.role = 'user'
    `);
    res.json(pending);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.get('/api/admin/users', authenticateToken, requireAdminOrSuper, async (req, res) => {
  try {
    const users = await dbQuery(`
      SELECT u.id, u.name, u.email, u.phone, u.role, u.location, u.is_blocked, u.created_at,
             p.specialization AS purohit_specialization, p.fee AS purohit_fee, p.image AS purohit_image,
             cp.category AS cottage_category, cp.address AS cottage_address, cp.capacity AS cottage_capacity, cp.image AS cottage_image,
             rp.transaction_id AS payment_transaction_id, rp.payment_status AS payment_status, rp.amount AS payment_amount
      FROM users u
      LEFT JOIN purohits p ON u.id = p.id
      LEFT JOIN cottage_partners cp ON u.id = cp.id
      LEFT JOIN registration_payments rp ON u.id = rp.user_id
      ORDER BY u.created_at DESC
    `);
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
    
    if (blockVal === 0) {
      if (targetUser.role === 'purohit') {
        await dbRun("UPDATE registration_payments SET payment_status = 'success' WHERE user_id = ?", [req.params.id]);
      }
      // Send activation notification
      const subject = `✦ Your Gurupadukam Partner Profile has been Activated! ✦`;
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #C9943A; border-radius: 12px; max-width: 600px; background-color: #FCFBF8; margin: auto;">
          <h2 style="color: #5C0A20; text-align: center; border-bottom: 2px solid #C9943A; padding-bottom: 12px;">gurupadukam.com</h2>
          <p style="font-size: 16px; color: #1A1A1A; font-weight: bold;">Dear ${targetUser.name},</p>
          <p style="font-size: 14px; color: #333; line-height: 1.6;">We are pleased to inform you that your administrative role request as a <strong>${targetUser.role.toUpperCase()}</strong> has been reviewed, approved, and activated by the platform's Super Administrator!</p>
          
          <div style="background-color: rgba(201,148,58,0.1); border-left: 4px solid #C9943A; padding: 15px; margin: 20px 0; border-radius: 4px;">
            <strong style="color: #5C0A20; font-size: 14px;">Activated Administrative Details:</strong>
            <ul style="margin: 8px 0 0 0; padding-left: 20px; font-size: 13px; color: #555; line-height: 1.5;">
              <li><strong>Role Desk:</strong> ${targetUser.role === 'purohit' ? 'Vetted Acharya (Priest)' : targetUser.role === 'admin' ? 'Hub Partner' : 'Cottage Artisan'}</li>
              <li><strong>Assigned Location:</strong> ${targetUser.location || 'All Hubs'}</li>
              <li><strong>Status:</strong> Active & Live 🟢</li>
            </ul>
          </div>
          
          <p style="font-size: 14px; color: #333; line-height: 1.6;">You can now log in using your registered credentials to access your professional dashboard, sync inventory catalogue items, view bookings, and manage welfare ledger accounts.</p>
          <div style="text-align: center; margin: 25px 0;">
            <a href="https://gurupadukam.com/login" style="background-color: #5C0A20; color: #FCFBF8; padding: 12px 25px; text-decoration: none; font-weight: bold; border-radius: 6px; font-size: 14px; display: inline-block;">Login to Partner Workspace</a>
          </div>
          
          <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
          <p style="font-size: 11px; color: #777; text-align: center; font-style: italic;">Thank you for your service and partnership in sustaining Vedic heritage and cottage arts.</p>
          <p style="font-size: 9px; color: #999; text-align: center; margin-top: 10px;">© gurupadukam.com. All rights reserved.</p>
        </div>
      `;
      sendEmailNotification(targetUser.email, subject, htmlContent);
      if (targetUser.phone) {
        sendSMSNotification(targetUser.phone, `Hari Om ${targetUser.name}! Your Gurupadukam partner profile as a ${targetUser.role.toUpperCase()} has been approved and activated by the Super-Admin. Access your dashboard at gurupadukam.com/login ✦`);
      }
    }
    
    res.json({ message: `User account successfully ${isBlocked ? 'suspended' : 'activated'}.` });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.delete('/api/admin/users/:id', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const user = await dbGet("SELECT * FROM users WHERE id = ?", [req.params.id]);
    if (!user) {
      return res.status(404).json({ error: 'Not Found', message: 'User registration request not found.' });
    }
    
    // Delete user from main users table
    await dbRun("DELETE FROM users WHERE id = ?", [req.params.id]);
    // Synchronize delete with purohits and cottage_partners tables
    await dbRun("DELETE FROM purohits WHERE id = ?", [req.params.id]);
    await dbRun("DELETE FROM cottage_partners WHERE id = ?", [req.params.id]);
    await dbRun("DELETE FROM registration_payments WHERE user_id = ?", [req.params.id]);
    
    // Send email rejection notification
    const subject = `✦ Status Update: Your Gurupadukam Partner Application ✦`;
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #C9943A; border-radius: 12px; max-width: 600px; background-color: #FCFBF8; margin: auto;">
        <h2 style="color: #5C0A20; text-align: center; border-bottom: 2px solid #C9943A; padding-bottom: 12px;">gurupadukam.com</h2>
        <p style="font-size: 16px; color: #1A1A1A; font-weight: bold;">Dear ${user.name},</p>
        <p style="font-size: 14px; color: #333; line-height: 1.6;">Thank you for your interest in partnering with Gurupadukam. Our administrative board has carefully reviewed your registration details and credentials.</p>
        
        <p style="font-size: 14px; color: #333; line-height: 1.6;">Regrettably, we are unable to approve your partner role request at this time. This decision is typically made when documentation is insufficient, licensing requirements are unmet, or we are unable to verify the provided credentials.</p>
        
        <div style="background-color: rgba(201,148,58,0.05); border-left: 4px solid #C9943A; padding: 15px; margin: 20px 0; border-radius: 4px;">
          <strong style="color: #5C0A20; font-size: 14px;">Application Information:</strong>
          <ul style="margin: 8px 0 0 0; padding-left: 20px; font-size: 13px; color: #555; line-height: 1.5;">
            <li><strong>Submitted Email:</strong> ${user.email}</li>
            <li><strong>Requested Role:</strong> ${user.role === 'purohit' ? 'Vaidik Acharya' : user.role === 'admin' ? 'Hub Partner' : 'Artisan Partner'}</li>
            <li><strong>Decision Status:</strong> Application Declined ❌</li>
          </ul>
        </div>
        
        <p style="font-size: 14px; color: #333; line-height: 1.6;">If you believe this was in error, please register again with accurate coordinates and documents or contact support at <a href="mailto:care.gurupadukam@gmail.com" style="color: #5C0A20; font-weight: bold; text-decoration: none;">care.gurupadukam@gmail.com</a>.</p>
        
        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="font-size: 9px; color: #999; text-align: center;">© gurupadukam.com. All rights reserved.</p>
      </div>
    `;
    sendEmailNotification(user.email, subject, htmlContent);
    
    res.json({ message: 'Registration request successfully declined and user records removed.' });
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

    // If upgraded to purohit, auto-provision and notify
    if (role === 'purohit') {
      const existingPurohit = await dbGet("SELECT * FROM purohits WHERE id = ?", [req.params.id]);
      if (!existingPurohit) {
        await dbRun(
          `INSERT INTO purohits (id, name, specialization, rating, fee, image, location, bookings_count, bio, credentials, email, phone, gov_id_type, gov_id_number, gov_id_image)
           VALUES (?, ?, ?, 5.0, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
          [
            req.params.id,
            targetUser.name,
            'Vedic Homams',
            3500,
            '/images/vedic_acharya.png',
            targetUser.location || 'Hyderabad',
            'Registered Gurupadukam Acharya',
            'Certified Priest',
            targetUser.email || '',
            targetUser.phone || '',
            'Aadhaar Card',
            '',
            '/images/auth/aadhaar_mock.png'
          ]
        );
      }
      
      // Update registration_payments to success if exists
      await dbRun("UPDATE registration_payments SET payment_status = 'success' WHERE user_id = ? AND amount = 11.0", [req.params.id]);
      
      // Send approval notification
      const subject = `✦ Your Gurupadukam Acharya Application Approved! ✦`;
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #C9943A; border-radius: 12px; max-width: 600px; background-color: #FCFBF8; margin: auto;">
          <h2 style="color: #5C0A20; text-align: center; border-bottom: 2px solid #C9943A; padding-bottom: 12px;">gurupadukam.com</h2>
          <p style="font-size: 16px; color: #1A1A1A; font-weight: bold;">Hari Om ${targetUser.name} ji!</p>
          <p style="font-size: 14px; color: #333; line-height: 1.6;">We are pleased to inform you that your application to become a registered Acharya/Purohit on Gurupadukam has been approved and activated! Your profile is now visible in the Acharya Peetam directory.</p>
          <p style="font-size: 14px; color: #333; line-height: 1.6; font-weight: bold; color: #5C0A20;">IMPORTANT ACTION REQUIRED: Please log in and complete your Acharya credentials form on your Profile page (specializations, fee, profile photo, biography, and credentials details) to finalize your directory listing.</p>
          <p style="font-size: 14px; color: #333; line-height: 1.6;">You can now log in to access your Priest Workspace dashboard, manage bookings, and communicate with devotees.</p>
          <div style="text-align: center; margin: 25px 0;">
            <a href="https://gurupadukam.com/login" style="background-color: #5C0A20; color: #FCFBF8; padding: 12px 25px; text-decoration: none; font-weight: bold; border-radius: 6px; font-size: 14px; display: inline-block;">Login to Priest Workspace</a>
          </div>
          <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
          <p style="font-size: 9px; color: #999; text-align: center;">© gurupadukam.com. All rights reserved.</p>
        </div>
      `;
      sendEmailNotification(targetUser.email, subject, htmlContent);
      if (targetUser.phone) {
        sendSMSNotification(targetUser.phone, `Hari Om ${targetUser.name} ji! Your Gurupadukam Acharya profile is approved. Action Required: Login at gurupadukam.com/login and update your credentials form on your profile page to finalize your listing ✦`);
      }
    }

    res.json({ message: 'User role and location updated successfully.', role, location: assignedLocation });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// --- Settings & Hubs Admin Config APIs ---
app.get('/api/admin/settings', authenticateToken, requireAdminOrSuper, async (req, res) => {
  try {
    const rows = await dbQuery("SELECT * FROM settings");
    const settings = {};
    rows.forEach(r => {
      settings[r.key] = r.value;
    });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/admin/settings', authenticateToken, requireAdminOrSuper, async (req, res) => {
  const settings = req.body;
  try {
    for (const [key, value] of Object.entries(settings)) {
      const existing = await dbGet("SELECT * FROM settings WHERE key = ?", [key]);
      if (existing) {
        await dbRun("UPDATE settings SET value = ? WHERE key = ?", [String(value), key]);
      } else {
        await dbRun("INSERT INTO settings (key, value) VALUES (?, ?)", [key, String(value)]);
      }
    }
    res.json({ message: 'Settings updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.get('/api/admin/hubs', authenticateToken, requireAdminOrSuper, async (req, res) => {
  try {
    const hubs = await dbQuery("SELECT * FROM hubs");
    res.json(hubs);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/admin/hubs', authenticateToken, requireAdminOrSuper, async (req, res) => {
  const { name, hours, coverage, license } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Bad Request', message: 'Hub name is required.' });
  }
  const id = `hub-${Date.now()}`;
  try {
    await dbRun("INSERT INTO hubs (id, name, hours, coverage, license) VALUES (?, ?, ?, ?, ?)", [id, name, hours || '', coverage || '', license || '']);
    res.json({ message: 'Hub added successfully.', id });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.put('/api/admin/hubs/:id', authenticateToken, requireAdminOrSuper, async (req, res) => {
  const { name, hours, coverage, license } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Bad Request', message: 'Hub name is required.' });
  }
  try {
    const existing = await dbGet("SELECT * FROM hubs WHERE id = ?", [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: 'Not Found', message: 'Hub not found.' });
    }
    await dbRun("UPDATE hubs SET name = ?, hours = ?, coverage = ?, license = ? WHERE id = ?", [name, hours || '', coverage || '', license || '', req.params.id]);
    res.json({ message: 'Hub updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.delete('/api/admin/hubs/:id', authenticateToken, requireAdminOrSuper, async (req, res) => {
  try {
    const existing = await dbGet("SELECT * FROM hubs WHERE id = ?", [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: 'Not Found', message: 'Hub not found.' });
    }
    await dbRun("DELETE FROM hubs WHERE id = ?", [req.params.id]);
    res.json({ message: 'Hub deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});


// --- 7. Gurukulam Classes APIs ---
// --- 7. Gurukulam Classes APIs & Session Proposals ---
app.get('/api/classes', async (req, res) => {
  try {
    const classes = await dbQuery("SELECT * FROM classes WHERE status = 'approved'");
    res.json(classes);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/classes', authenticateToken, requireAdminOrSuperOrPurohit, async (req, res) => {
  const { title, instructor_name, time, fee, image, description } = req.body;
  if (!title || !instructor_name || !time || fee === undefined || !image || !description) {
    return res.status(400).json({ error: 'Bad Request', message: 'All class details are required.' });
  }
  try {
    const classId = 'cls-' + Math.random().toString(36).substr(2, 9);
    const status = req.user.role === 'super_admin' ? 'approved' : 'pending';
    
    await dbRun(
      "INSERT INTO classes (id, title, instructor_name, time, fee, image, description, status, proposer_name, proposer_location) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [classId, title, instructor_name, time, Number(fee), image, description, status, req.user.name, req.user.location || 'Hub Location']
    );

    res.status(201).json({ 
      message: req.user.role === 'super_admin' 
        ? 'Gurukulam class batch added successfully.' 
        : 'Training session request submitted successfully! Pending Super-Admin approval. ✦', 
      classId 
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.get('/api/classes/proposed', authenticateToken, requireAdminOrSuperOrPurohit, async (req, res) => {
  try {
    let classes;
    if (req.user.role === 'super_admin' || req.user.role === 'admin') {
      classes = await dbQuery("SELECT * FROM classes ORDER BY id DESC");
    } else {
      classes = await dbQuery("SELECT * FROM classes WHERE proposer_name = ? ORDER BY id DESC", [req.user.name]);
    }
    res.json(classes);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.get('/api/classes/my', authenticateToken, async (req, res) => {
  try {
    const regs = await dbQuery(
      `SELECT r.*, c.title, c.instructor_name, c.time, c.image, c.description 
       FROM class_registrations r
       JOIN classes c ON r.class_id = c.id
       WHERE r.user_id = ?
       ORDER BY r.date DESC`,
      [req.user.id]
    );
    res.json(regs);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/classes/:id/register', authenticateToken, async (req, res) => {
  const classId = req.params.id;
  const { student_name, student_age, parent_phone, experience_level } = req.body;
  
  if (!student_name || !student_age || !parent_phone || !experience_level) {
    return res.status(400).json({ error: 'Bad Request', message: 'All student coordinates and parental contact fields are required.' });
  }

  try {
    const cls = await dbGet("SELECT * FROM classes WHERE id = ?", [classId]);
    if (!cls) {
      return res.status(404).json({ error: 'Not Found', message: 'Class batch not found.' });
    }
    
    // Check if already registered
    const existing = await dbGet("SELECT * FROM class_registrations WHERE class_id = ? AND user_id = ?", [classId, req.user.id]);
    if (existing) {
      return res.status(400).json({ error: 'Bad Request', message: 'You are already registered for this Gurukulam class.' });
    }

    const regId = 'reg-' + Math.random().toString(36).substr(2, 9);
    
    const generateMeetCode = () => {
      const abc = 'abcdefghijklmnopqrstuvwxyz';
      const part = (len) => Array.from({ length: len }, () => abc[Math.floor(Math.random() * abc.length)]).join('');
      return `https://meet.google.com/${part(3)}-${part(4)}-${part(3)}`;
    };
    const googleMeetLink = generateMeetCode();

    await dbRun(
      `INSERT INTO class_registrations (id, class_id, user_id, user_name, user_email, student_name, student_age, parent_phone, experience_level, google_meet_link) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [regId, classId, req.user.id, req.user.name, req.user.email, student_name, Number(student_age), parent_phone, experience_level, googleMeetLink]
    );

    // Send Cohort Confirmation Email & SMS
    try {
      const subject = `✦ Consecrated Live Enrollment: Gurukulam Batch – ${cls.title} 🌿`;
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #C9943A; border-radius: 12px; max-width: 600px; background-color: #FCFBF8; margin: auto;">
          <img src="https://gurupadukam.com/gurupadukam_logo.png" alt="Gurupadukam Logo" style="display: block; margin: 0 auto 15px auto; width: 70px; height: 70px; border-radius: 50%; border: 2px solid #C9943A;" />
          <h2 style="color: #5C0A20; text-align: center; border-bottom: 2px solid #C9943A; padding-bottom: 12px; margin-top: 0; font-family: 'Cinzel', Georgia, serif; font-size: 20px;">gurupadukam.com</h2>
          <p style="font-size: 15px; color: #1A1A1A; font-weight: bold;">Hari Om, ${req.user.name} ji!</p>
          <p style="font-size: 13px; color: #333; line-height: 1.5;">Congratulations! Your seat has been successfully reserved in our sacred Gurukulam study batch for <strong>${cls.title}</strong>.</p>
          
          <div style="margin: 20px 0; background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; padding: 15px; font-size: 12px; line-height: 1.6;">
            <strong style="color: #5C0A20; font-size: 13px; display: block; border-bottom: 1px solid #eee; padding-bottom: 5px; margin-bottom: 8px;">Gurukulam Class Details:</strong>
            <strong>Enrollment ID:</strong> ${regId}<br>
            <strong>Student Name:</strong> ${student_name} (Age: ${student_age})<br>
            <strong>Topic:</strong> ${cls.title}<br>
            <strong>Acharya / Instructor:</strong> ${cls.instructor_name}<br>
            <strong>Scheduled Time:</strong> ${cls.time}<br>
            <strong>Google Meet Call:</strong> <a href="${googleMeetLink}" style="color: #5C0A20; font-weight: bold;">Join Live Session Room</a><br>
            <strong>Syllabus Description:</strong> ${cls.description}
          </div>

          <p style="font-size: 13px; color: #333; line-height: 1.5;">The class links, study guides, and recitation worksheets will be sent to this email address 10 minutes prior to the scheduled slot. Please make sure to be in a quiet space, ready for spiritual learning.</p>
          <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
          <p style="font-size: 11px; color: #777; text-align: center; font-style: italic;">"Satsangatve Nissangatvam, Nissangatve Nirmohatvam."</p>
          <p style="font-size: 9px; color: #999; text-align: center; margin-top: 10px;">© gurupadukam.com. All rights reserved.</p>
        </div>
      `;
      
      sendEmailNotification(req.user.email, subject, htmlContent);
      if (parent_phone) {
        sendSMSNotification(parent_phone, `Hari Om! Gurukulam batch confirmed for ${student_name} (${cls.title}) on ${cls.time}. Join Live Meet call: ${googleMeetLink} ✦`);
      }
    } catch (notifErr) {
      console.error('[Notification Dispatch Failed on Class Registration]:', notifErr.message);
    }

    res.json({ message: 'Successfully registered for the class! Consecrated Meet link dispatched.' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.get('/api/classes/:id/registrations', authenticateToken, requireAdminOrSuperOrPurohit, async (req, res) => {
  const classId = req.params.id;
  try {
    const cls = await dbGet("SELECT * FROM classes WHERE id = ?", [classId]);
    if (!cls) {
      return res.status(404).json({ error: 'Not Found', message: 'Class not found.' });
    }
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && cls.proposer_name !== req.user.name) {
      return res.status(403).json({ error: 'Forbidden', message: 'You are only authorized to view registrations for classes you proposed.' });
    }
    const regs = await dbQuery("SELECT * FROM class_registrations WHERE class_id = ? ORDER BY date DESC", [classId]);
    res.json(regs);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// Admin training proposals list (Super Admin View)
app.get('/api/admin/class-proposals', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const proposals = await dbQuery("SELECT * FROM classes WHERE status = 'pending' ORDER BY id DESC");
    res.json(proposals);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// Super Admin approve sessional proposal
app.post('/api/admin/classes/:id/approve', authenticateToken, requireSuperAdmin, async (req, res) => {
  const classId = req.params.id;
  try {
    const cls = await dbGet("SELECT * FROM classes WHERE id = ?", [classId]);
    if (!cls) {
      return res.status(404).json({ error: 'Not Found', message: 'Proposed training session not found.' });
    }
    
    await dbRun("UPDATE classes SET status = 'approved' WHERE id = ?", [classId]);
    
    // Log dynamic notification
    const notifId = 'notif-' + Math.random().toString(36).substr(2, 9);
    await dbRun(
      `INSERT INTO notifications (id, title, \`desc\`, \`read\`) VALUES (?, ?, ?, 0)`,
      [notifId, `Session Approved`, `The training/recitation session "${cls.title}" proposed by ${cls.proposer_name || 'Admin'} was successfully approved and added to the calendar.`]
    );

    res.json({ message: 'Proposed sessional cohort approved and live on the calendar successfully! ✦' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// Super Admin reject/delete proposed session
app.post('/api/admin/classes/:id/reject', authenticateToken, requireSuperAdmin, async (req, res) => {
  const classId = req.params.id;
  try {
    await dbRun("DELETE FROM classes WHERE id = ?", [classId]);
    res.json({ message: 'Proposed sessional cohort rejected and deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// Super Admin unapprove/de-list sessional cohort
app.post('/api/admin/classes/:id/unapprove', authenticateToken, requireSuperAdmin, async (req, res) => {
  const classId = req.params.id;
  try {
    const cls = await dbGet("SELECT * FROM classes WHERE id = ?", [classId]);
    if (!cls) {
      return res.status(404).json({ error: 'Not Found', message: 'Proposed training session not found.' });
    }
    
    await dbRun("UPDATE classes SET status = 'pending' WHERE id = ?", [classId]);
    
    // Log dynamic notification
    const notifId = 'notif-' + Math.random().toString(36).substr(2, 9);
    await dbRun(
      `INSERT INTO notifications (id, title, \`desc\`, \`read\`) VALUES (?, ?, ?, 0)`,
      [notifId, `Session Unapproved`, `The training/recitation session "${cls.title}" has been unapproved and returned to the review queue.`]
    );

    res.json({ message: 'Session successfully unapproved and moved back to pending queue. ✦' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// Proposer/Admin edit sessional cohort coordinates
app.put('/api/classes/:id', authenticateToken, requireAdminOrSuperOrPurohit, async (req, res) => {
  const classId = req.params.id;
  const { title, instructor_name, time, fee, image, description } = req.body;
  
  if (!title || !instructor_name || !time || fee === undefined || !image || !description) {
    return res.status(400).json({ error: 'Bad Request', message: 'All class details are required.' });
  }

  try {
    const cls = await dbGet("SELECT * FROM classes WHERE id = ?", [classId]);
    if (!cls) {
      return res.status(404).json({ error: 'Not Found', message: 'Class cohort not found.' });
    }

    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && cls.proposer_name !== req.user.name) {
      return res.status(403).json({ error: 'Forbidden', message: 'You can only edit your own proposed sessional cohorts.' });
    }

    const newStatus = req.user.role === 'super_admin' ? 'approved' : 'pending';

    await dbRun(
      `UPDATE classes 
       SET title = ?, instructor_name = ?, time = ?, fee = ?, image = ?, description = ?, status = ?, proposer_name = ?
       WHERE id = ?`,
      [title, instructor_name, time, Number(fee), image, description, newStatus, req.user.name, classId]
    );

    res.json({
      message: req.user.role === 'super_admin'
        ? 'Gurukulam class details scheduled and updated successfully.'
        : 'Class modifications submitted successfully! Pending Super-Admin confirmation. ✦',
      status: newStatus
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// Proposer/Admin delete sessional cohort
app.delete('/api/classes/:id', authenticateToken, requireAdminOrSuperOrPurohit, async (req, res) => {
  const classId = req.params.id;
  try {
    const cls = await dbGet("SELECT * FROM classes WHERE id = ?", [classId]);
    if (!cls) {
      return res.status(404).json({ error: 'Not Found', message: 'Class cohort not found.' });
    }

    // Standard Admin can only delete their own proposed/pending class, Super Admin can override delete anything
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin' && cls.proposer_name !== req.user.name) {
      return res.status(403).json({ error: 'Forbidden', message: 'You can only delete your own proposed sessional cohorts.' });
    }

    await dbRun("DELETE FROM classes WHERE id = ?", [classId]);
    res.json({ message: 'Class cohort successfully deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});


// --- 7a. Live Events & Pravachanas APIs ---
app.get('/api/events', async (req, res) => {
  try {
    const events = await dbQuery("SELECT * FROM events WHERE status = 'approved' ORDER BY date_time ASC");
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/events', authenticateToken, async (req, res) => {
  const { title, category, description, date_time, location, organizer_name } = req.body;
  if (!title || !category || !description || !date_time || !location || !organizer_name) {
    return res.status(400).json({ error: 'Bad Request', message: 'All event details are required.' });
  }
  try {
    const eventId = 'evt-' + Math.random().toString(36).substr(2, 9);
    const status = req.user.role === 'super_admin' ? 'approved' : 'pending';
    
    await dbRun(
      "INSERT INTO events (id, title, category, description, date_time, location, organizer_name, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [eventId, title, category, description, date_time, location, organizer_name, status]
    );

    if (status === 'approved') {
      triggerEventApprovedNotifications({ id: eventId, title, category, description, date_time, location, organizer_name });
    }

    res.status(201).json({
      message: status === 'approved'
        ? 'Event published live successfully.'
        : 'Event request submitted successfully! Pending verification by Acharyas or Admins. ✦',
      eventId
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.get('/api/admin/events/pending', authenticateToken, requireAdminOrSuperOrPurohit, async (req, res) => {
  try {
    const events = await dbQuery("SELECT * FROM events WHERE status = 'pending' ORDER BY id DESC");
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/admin/events/:id/approve', authenticateToken, requireAdminOrSuperOrPurohit, async (req, res) => {
  const eventId = req.params.id;
  try {
    const event = await dbGet("SELECT * FROM events WHERE id = ?", [eventId]);
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Event not found.' });
    }
    
    await dbRun("UPDATE events SET status = 'approved' WHERE id = ?", [eventId]);
    
    // Log administrative notification
    const notifId = 'notif-' + Math.random().toString(36).substr(2, 9);
    await dbRun(
      `INSERT INTO notifications (id, title, \`desc\`, \`read\`) VALUES (?, ?, ?, 0)`,
      [notifId, `Event Approved: ${event.title}`, `The live event "${event.title}" (${event.category}) has been verified and approved by ${req.user.name}.`]
    );

    // Trigger devotee notification broadcast
    triggerEventApprovedNotifications(event);

    res.json({ message: 'Event verified, published live, and notification broadcast dispatched! ✦' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/admin/events/:id/reject', authenticateToken, requireAdminOrSuperOrPurohit, async (req, res) => {
  const eventId = req.params.id;
  try {
    await dbRun("DELETE FROM events WHERE id = ?", [eventId]);
    res.json({ message: 'Proposed event proposal rejected and removed.' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// Helper function to broadcast event notifications in the background
async function triggerEventApprovedNotifications(event) {
  try {
    const devotees = await dbQuery("SELECT name, email, phone FROM users WHERE role = 'user'");
    for (const devotee of devotees) {
      if (devotee.email) {
        const emailSubject = `✦ Sacred Invitation: Live Event – ${event.title} 🌿`;
        const emailBody = `
          <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #C9943A; border-radius: 12px; max-width: 600px; background-color: #FCFBF8; margin: auto;">
            <img src="https://gurupadukam.com/gurupadukam_logo.png" alt="Gurupadukam Logo" style="display: block; margin: 0 auto 15px auto; width: 70px; height: 70px; border-radius: 50%; border: 2px solid #C9943A;" />
            <h2 style="color: #5C0A20; text-align: center; border-bottom: 2px solid #C9943A; padding-bottom: 12px; margin-top: 0; font-family: 'Cinzel', Georgia, serif; font-size: 20px;">gurupadukam.com</h2>
            <p style="font-size: 15px; color: #1A1A1A; font-weight: bold;">Hari Om, ${devotee.name} ji!</p>
            <p style="font-size: 13px; color: #333; line-height: 1.5;">We are pleased to invite you to a sacred live gathering at Gurupadukam:</p>
            
            <div style="margin: 20px 0; background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; padding: 15px; font-size: 12px; line-height: 1.6;">
              <strong style="color: #5C0A20; font-size: 13px; display: block; border-bottom: 1px solid #eee; padding-bottom: 5px; margin-bottom: 8px;">Event Details:</strong>
              <strong>Event:</strong> ${event.title}<br>
              <strong>Category:</strong> ${event.category}<br>
              <strong>Date & Time:</strong> ${event.date_time}<br>
              <strong>Venue / Link:</strong> ${event.location}<br>
              <strong>Organized by:</strong> ${event.organizer_name}<br>
              <strong>Description:</strong> ${event.description}
            </div>

            <p style="font-size: 13px; color: #333; line-height: 1.5;">Join us to experience scriptural wisdom, divine vibes, and community bonding. Please save this date in your calendar.</p>
            <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
            <p style="font-size: 11px; color: #777; text-align: center; font-style: italic;">"Satsangatve Nissangatvam, Nissangatve Nirmohatvam."</p>
            <p style="font-size: 9px; color: #999; text-align: center; margin-top: 10px;">© gurupadukam.com. All rights reserved.</p>
          </div>
        `;
        sendEmailNotification(devotee.email, emailSubject, emailBody);
      }
      if (devotee.phone) {
        sendSMSNotification(devotee.phone, `Hari Om! New Live Event scheduled: ${event.title} (${event.category}) on ${event.date_time}. Join us at ${event.location} ✦`);
      }
    }
  } catch (err) {
    console.error('[Event Notification Dispatch Failed]:', err.message);
  }
}


// --- 8. Vetted Purohits Booking APIs ---
app.get('/api/purohits', async (req, res) => {
  try {
    const purohits = await dbQuery(`
      SELECT p.* FROM purohits p
      JOIN users u ON p.id = u.id
      WHERE u.role = 'purohit' AND u.is_blocked = 0
      ORDER BY p.rating DESC, p.bookings_count DESC
    `);
    res.json(purohits);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.get('/api/purohits/:id', async (req, res) => {
  try {
    const purohitId = req.params.id;
    const purohit = await dbGet("SELECT * FROM purohits WHERE id = ?", [purohitId]);
    if (!purohit) {
      return res.status(404).json({ error: 'Not Found', message: 'Priest not found.' });
    }

    const reviews = await dbQuery("SELECT * FROM purohit_reviews WHERE purohit_id = ? ORDER BY created_at DESC", [purohitId]);

    // Check if the current calling user has a booking with this priest
    let hasBooked = false;
    let authUser = null;
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        authUser = decoded;
        const bookingCheck = await dbGet(
          "SELECT id FROM purohit_bookings WHERE user_id = ? AND purohit_id = ? LIMIT 1",
          [decoded.id, purohitId]
        );
        if (bookingCheck) {
          hasBooked = true;
        }
      } catch (e) {
        // Token validation error
      }
    }

    // Mask phone & email if not booked
    const responseProfile = { ...purohit };
    const isOwner = authUser && authUser.id === purohitId;
    const isAdmin = authUser && (authUser.role === 'admin' || authUser.role === 'super_admin');
    
    if (!hasBooked && !isOwner && !isAdmin) {
      responseProfile.phone = undefined;
      responseProfile.email = undefined;
    }

    res.json({
      purohit: responseProfile,
      reviews,
      hasBooked
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.put('/api/purohits/:id', authenticateToken, async (req, res) => {
  const purohitId = req.params.id;
  if (req.user.id !== purohitId && req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Forbidden', message: 'You are not authorized to modify this profile.' });
  }

  const { name, specialization, fee, image, bio, credentials, portfolioImages, email, phone, location } = req.body;
  
  if (!name || !specialization || !location) {
    return res.status(400).json({ error: 'Bad Request', message: 'Name, Specialization, and Location are required.' });
  }

  try {
    const userExists = await dbGet("SELECT * FROM users WHERE id = ?", [purohitId]);
    if (!userExists) {
      return res.status(404).json({ error: 'Not Found', message: 'User not found.' });
    }

    let pList = [];
    if (portfolioImages) {
      try {
        pList = Array.isArray(portfolioImages) ? portfolioImages : JSON.parse(portfolioImages);
        if (pList.length > 3) {
          pList = pList.slice(0, 3);
        }
      } catch (e) {
        pList = [];
      }
    }

    // Sync users table
    await dbRun(
      "UPDATE users SET name = ?, email = ?, phone = ?, location = ? WHERE id = ?",
      [name, email || userExists.email, phone || userExists.phone, location, purohitId]
    );

    // Sync purohits table
    await dbRun(
      `UPDATE purohits SET 
        name = ?, specialization = ?, fee = ?, image = ?, 
        bio = ?, credentials = ?, portfolio_images = ?, 
        email = ?, phone = ?, location = ? 
       WHERE id = ?`,
      [
        name, specialization, fee ? Number(fee) : 0, image || '/images/vedic_acharya.png',
        bio || '', credentials || '', JSON.stringify(pList),
        email || userExists.email, phone || userExists.phone, location, purohitId
      ]
    );

    res.json({ success: true, message: '✦ Profile modified successfully! ✦' });
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
    // Return a clean directory with bookings count only, no welfare balances
    const purohits = await dbQuery("SELECT id, name, location, bookings_count, fee FROM purohits ORDER BY bookings_count DESC");
    const ledger = purohits.map(p => {
      return {
        id: p.id,
        name: p.name,
        location: p.location,
        bookingsCount: p.bookings_count,
        pfBalance: 0,
        insuranceStatus: 'Showcase Profile',
        insuranceCover: 0
      };
    });
    res.json(ledger);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/purohits/:id/book', authenticateToken, async (req, res) => {
  const purohitId = req.params.id;
  const { poojaType, bookingDate, timeSlot, ritualMode, email } = req.body;
  let { address } = req.body;
  
  if (ritualMode === 'Online' && !address) {
    address = 'Online Virtual Session';
  }
  
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
          { id: 'item-1', name: 'Pure Pasupu (Turmeric Powder) - 100g', quantity: 5, price: 149, isStoreProduct: true, storeProductId: 'p1' },
          { id: 'item-2', name: 'Pure Kumkum - 100g', quantity: 2, price: 129, isStoreProduct: true, storeProductId: 'p2' },
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
          { id: 'item-2', name: 'Pure Pasupu (Turmeric Powder) - 100g', quantity: 2, price: 149, isStoreProduct: true, storeProductId: 'p1' },
          { id: 'item-3', name: 'Pure Kumkum - 100g', quantity: 1, price: 129, isStoreProduct: true, storeProductId: 'p2' },
          { id: 'item-4', name: 'Gandham (Chandanam Sandalwood Paste) - 50g', quantity: 1, price: 249, isStoreProduct: true, storeProductId: 'p3' },
          { id: 'item-5', name: 'Sacred Coconuts', quantity: 2, price: 40, isStoreProduct: false }
        ]
      : [
          { id: 'item-1', name: 'Complete 5-in-1 Puja Combo Kit', quantity: 1, price: 599, isStoreProduct: true, storeProductId: 'p6' },
          { id: 'item-2', name: 'Pure Pasupu (Turmeric Powder) - 100g', quantity: 1, price: 149, isStoreProduct: true, storeProductId: 'p1' },
          { id: 'item-3', name: 'Pure Kumkum - 100g', quantity: 1, price: 129, isStoreProduct: true, storeProductId: 'p2' }
        ];

    const mode = ritualMode || 'Offline';
    const bookingId = 'bk-' + Math.random().toString(36).substr(2, 9);
    
    await dbRun(
      `INSERT INTO purohit_bookings (id, purohit_id, user_id, pooja_type, booking_date, time_slot, address, status, items, secure_deposit, ritual_mode, google_meet_link)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending_Acharya_Confirmation', ?, 0, ?, ?)`,
      [bookingId, purohitId, req.user.id, poojaType, bookingDate, timeSlot, address, JSON.stringify(defaultChecklist), mode, null]
    );

    // Increment bookings count
    await dbRun("UPDATE purohits SET bookings_count = bookings_count + 1 WHERE id = ?", [purohitId]);

    // Send a notification to Admin
    const notifId = 'notif-' + Math.random().toString(36).substr(2, 9);
    await dbRun(
      `INSERT INTO notifications (id, title, \`desc\`, \`read\`) VALUES (?, ?, ?, 0)`,
      [notifId, `New Purohit Booking`, `Purohit booking ${bookingId} placed by ${req.user.name} for ${poojaType} on ${bookingDate}.`]
    );

    // Send Booking Notification Email & SMS to Priest only (Devotee gets notified on Confirmation)
    try {
      const devotee = await dbGet("SELECT name, email, phone FROM users WHERE id = ?", [req.user.id]);
      const priestUser = await dbGet("SELECT email, phone FROM users WHERE id = ?", [purohitId]);

      const devoteeEmail = email || devotee?.email || req.user.email;
      const devoteePhone = devotee?.phone;
      const devoteeName = devotee?.name || req.user.name;

      if (email && !devotee?.email) {
        await dbRun("UPDATE users SET email = ? WHERE id = ?", [email, req.user.id]);
      }

      // Notify Priest
      if (priestUser && priestUser.email) {
        const priestSubject = `✦ Action Required: New Pooja Booking: ${poojaType} – Gurupadukam 🌿`;
        const priestHtml = `
          <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #C9943A; border-radius: 12px; max-width: 600px; background-color: #FCFBF8; margin: auto;">
            <h2 style="color: #5C0A20; text-align: center; border-bottom: 2px solid #C9943A; padding-bottom: 12px; margin-top: 0;">gurupadukam.com</h2>
            <p style="font-size: 15px; color: #1A1A1A; font-weight: bold;">Hari Om, ${purohit.name} Acharya ji!</p>
            <p style="font-size: 13px; color: #333; line-height: 1.5;">You have been requested for a new sacred pooja booking. Please review and confirm to generate the Google Meet link (if online).</p>
            
            <div style="margin: 20px 0; background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; padding: 15px; font-size: 12px; line-height: 1.6;">
              <strong style="color: #5C0A20; font-size: 13px; display: block; border-bottom: 1px solid #eee; padding-bottom: 5px; margin-bottom: 8px;">Request Details:</strong>
              <strong>Booking ID:</strong> ${bookingId}<br>
              <strong>Pooja Type:</strong> ${poojaType}<br>
              <strong>Date:</strong> ${bookingDate}<br>
              <strong>Time Slot:</strong> ${timeSlot}<br>
              <strong>Devotee Name:</strong> ${devoteeName}<br>
              <strong>Devotee Contact:</strong> ${devoteePhone || devoteeEmail}<br>
              <strong>Venue Address:</strong> ${address}
            </div>

            <p style="font-size: 13px; color: #333; line-height: 1.5;">Log in to your Purohit Dashboard to confirm the booking.</p>
            <div style="text-align: center; margin: 25px 0;">
              <a href="https://gurupadukam.com/login" style="background-color: #5C0A20; color: #FCFBF8; padding: 12px 25px; text-decoration: none; font-weight: bold; border-radius: 6px; font-size: 14px; display: inline-block;">Access Priest Workspace</a>
            </div>
          </div>
        `;
        sendEmailNotification(priestUser.email, priestSubject, priestHtml, []);
        if (priestUser.phone) {
          const smsMsg = `Hari Om Acharya ji! New booking ${bookingId} for ${poojaType} on ${bookingDate}. Devotee: ${devoteeName}, Phone: ${devoteePhone || 'N/A'}, Address: ${address}. Deposit of ₹11 received. Please login to confirm ✦`;
          sendSMSNotification(priestUser.phone, smsMsg);
        }
      }
    } catch (notifErr) {
      console.error('[Notification Dispatch Failed on Booking Request]:', notifErr.message);
    }

    res.status(201).json({ 
      message: 'Purohit booking requested! Awaiting Acharya confirmation.', 
      bookingId
    });  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/purohits/bookings/:bookingId/confirm', authenticateToken, requirePurohitRole, async (req, res) => {
  const { bookingId } = req.params;
  
  try {
    const booking = await dbGet("SELECT * FROM purohit_bookings WHERE id = ?", [bookingId]);
    if (!booking) {
      return res.status(404).json({ error: 'Not Found', message: 'Booking not found.' });
    }

    if (booking.purohit_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden', message: 'You are not authorized to confirm this booking.' });
    }

    if (booking.status === 'Confirmed') {
      return res.status(400).json({ error: 'Bad Request', message: 'Booking is already confirmed.' });
    }

    const purohit = await dbGet("SELECT * FROM purohits WHERE id = ?", [req.user.id]);
    const devotee = await dbGet("SELECT name, email, phone, communication_preferences FROM users WHERE id = ?", [booking.user_id]);
    
    if (!purohit || !devotee) {
      return res.status(404).json({ error: 'Not Found', message: 'Related users not found.' });
    }

    const generateMeetCode = () => {
      const abc = 'abcdefghijklmnopqrstuvwxyz';
      const part = (len) => Array.from({ length: len }, () => abc[Math.floor(Math.random() * abc.length)]).join('');
      return `https://meet.google.com/${part(3)}-${part(4)}-${part(3)}`;
    };
    const meetLink = booking.ritual_mode === 'Online' ? generateMeetCode() : null;

    await dbRun(
      "UPDATE purohit_bookings SET status = 'Confirmed', google_meet_link = ? WHERE id = ?",
      [meetLink, bookingId]
    );

    // Prepare Notifications
    const prefs = devotee.communication_preferences ? JSON.parse(devotee.communication_preferences) : { sms: true, whatsapp: true, email: true };
    const calendarSummary = `Vedic Ritual: ${booking.pooja_type} with ${purohit.name} Acharya`;
    const calendarDesc = `Hari Om! Your sacred booking for ${booking.pooja_type} is confirmed.\n\nBooking ID: ${bookingId}\nPurohit: ${purohit.name}\nDate: ${booking.booking_date}\nTime: ${booking.time_slot}\nLocation: ${booking.address}\n\nGoogle Meet: ${meetLink || 'N/A'}\n\nThank you for choosing gurupadukam.com.`;

    const icsString = generateICS(bookingId, booking.pooja_type, booking.booking_date, booking.time_slot, meetLink || booking.address, calendarSummary, calendarDesc);
    const googleCalendarUrl = generateGoogleCalendarUrl(bookingId, booking.pooja_type, booking.booking_date, booking.time_slot, meetLink || booking.address, calendarSummary, calendarDesc);

    if (prefs.email && devotee.email) {
      const emailAttachments = [{ filename: 'invite.ics', content: icsString, contentType: 'text/calendar; charset=utf-8; method=REQUEST' }];
      const devoteeSubject = `✦ Confirmed Booking: Vedic Ritual with ${purohit.name} Acharya 🌿`;
      const devoteeHtml = `
        <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #C9943A; border-radius: 12px; max-width: 600px; background-color: #FCFBF8; margin: auto;">
          <h2 style="color: #5C0A20; text-align: center; border-bottom: 2px solid #C9943A; padding-bottom: 12px; margin-top: 0;">gurupadukam.com</h2>
          <p style="font-size: 15px; color: #1A1A1A; font-weight: bold;">Hari Om, ${devotee.name} ji!</p>
          <p style="font-size: 13px; color: #333; line-height: 1.5;">Your sacred booking for the <strong>${booking.pooja_type}</strong> ritual has been confirmed! Our certified Vedic Purohit, ${purohit.name}, has accepted this spiritual assignment.</p>
          
          <div style="margin: 20px 0; background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; padding: 15px; font-size: 12px; line-height: 1.6;">
            <strong style="color: #5C0A20; font-size: 13px; display: block; border-bottom: 1px solid #eee; padding-bottom: 5px; margin-bottom: 8px;">Ritual Coordinates:</strong>
            <strong>Booking ID:</strong> ${bookingId}<br>
            <strong>Pooja Type:</strong> ${booking.pooja_type}<br>
            <strong>Date:</strong> ${booking.booking_date}<br>
            <strong>Time Slot:</strong> ${booking.time_slot}<br>
            <strong>Purohit:</strong> ${purohit.name}<br>
            <strong>Ritual Venue Address:</strong> ${booking.address}${booking.ritual_mode === 'Online' ? `<br><strong>Google Meet Link:</strong> <a href="${meetLink}" style="color: #5C0A20; font-weight: bold;">Join Google Meet Session</a>` : ''}
          </div>

          <div style="text-align: center; margin: 25px 0;">
            <a href="${googleCalendarUrl}" style="background-color: #C9943A; color: #5C0A20; padding: 12px 25px; text-decoration: none; font-weight: bold; border-radius: 6px; font-size: 13px; display: inline-block; border: 1px solid #5C0A20; text-transform: uppercase; letter-spacing: 1px;">Add to Google Calendar 📅</a>
          </div>

          <p style="font-size: 13px; color: #333; line-height: 1.5;">Our Purohit will contact you shortly to coordinate any specific details or family gotra/nakshatra sankalpam inputs.</p>
        </div>
      `;
      sendEmailNotification(devotee.email, devoteeSubject, devoteeHtml, emailAttachments);
    }

    // Notify Priest as well
    if (purohit.email) {
      const priestConfirmSubject = `✦ Confirmed Booking: Devotee ${devotee.name} – Gurupadukam 🌿`;
      const priestConfirmHtml = `
        <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #C9943A; border-radius: 12px; max-width: 600px; background-color: #FCFBF8; margin: auto;">
          <h2 style="color: #5C0A20; text-align: center; border-bottom: 2px solid #C9943A; padding-bottom: 12px; margin-top: 0;">gurupadukam.com</h2>
          <p style="font-size: 15px; color: #1A1A1A; font-weight: bold;">Hari Om, ${purohit.name} Acharya ji!</p>
          <p style="font-size: 13px; color: #333; line-height: 1.5;">You have successfully confirmed the booking for <strong>${booking.pooja_type}</strong> with devotee ${devotee.name}.</p>
          
          <div style="margin: 20px 0; background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; padding: 15px; font-size: 12px; line-height: 1.6;">
            <strong style="color: #5C0A20; font-size: 13px; display: block; border-bottom: 1px solid #eee; padding-bottom: 5px; margin-bottom: 8px;">Confirmed Details:</strong>
            <strong>Booking ID:</strong> ${bookingId}<br>
            <strong>Pooja Type:</strong> ${booking.pooja_type}<br>
            <strong>Date:</strong> ${booking.booking_date}<br>
            <strong>Time Slot:</strong> ${booking.time_slot}<br>
            <strong>Devotee Name:</strong> ${devotee.name}<br>
            <strong>Devotee Contact:</strong> ${devotee.phone || devotee.email}<br>
            <strong>Venue Address:</strong> ${booking.address}${booking.ritual_mode === 'Online' ? `<br><strong>Google Meet Link:</strong> <a href="${meetLink}" style="color: #5C0A20; font-weight: bold;">Join Google Meet Session</a>` : ''}
          </div>
          <p style="font-size: 13px; color: #333; line-height: 1.5;">Please access your dashboard to view the booking and customized checklist.</p>
        </div>
      `;
      sendEmailNotification(purohit.email, priestConfirmSubject, priestConfirmHtml, [{ filename: 'invite.ics', content: icsString, contentType: 'text/calendar; charset=utf-8; method=REQUEST' }]);
    }

    if (purohit.phone) {
      const priestSms = booking.ritual_mode === 'Online'
        ? `Hari Om! Confirmed Online Puja booking ${bookingId} for devotee ${devotee.name}. Join Google Meet: ${meetLink} ✦`
        : `Hari Om! Confirmed Puja booking ${bookingId} for devotee ${devotee.name} on ${booking.booking_date} at ${booking.address}. ✦`;
      sendSMSNotification(purohit.phone, priestSms);
    }

    if (devotee.phone) {
      const msg = booking.ritual_mode === 'Online'
        ? `Hari Om! Online Puja confirmed with ${purohit.name} on ${booking.booking_date}. Join Google Meet: ${meetLink} ✦`
        : `Hari Om! Puja booking ${bookingId} confirmed with ${purohit.name} for ${booking.pooja_type} on ${booking.booking_date}. ✦`;
      
      if (prefs.sms) sendSMSNotification(devotee.phone, msg);
      if (prefs.whatsapp) console.log(`[Simulated WhatsApp to ${devotee.phone}]: ${msg}`);
    }

    res.json({ message: 'Booking confirmed successfully', googleMeetLink: meetLink });
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
    
    // Calculate dynamic reviews
    const reviews = await dbQuery("SELECT * FROM purohit_reviews WHERE purohit_id = ? ORDER BY created_at DESC", [req.user.id]);
    const reviewCount = reviews.length;

    res.json({
      ...purohit,
      reviews,
      reviewCount
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
  const { purohitId, purohitIds, pujaType, preferredDate, details } = req.body;
  if (!pujaType || !preferredDate || !details) {
    return res.status(400).json({ error: 'Bad Request', message: 'Puja type, preferred date, and requirements details are required.' });
  }
  try {
    const targetIds = Array.isArray(purohitIds) ? purohitIds.slice(0, 3) : (purohitId ? [purohitId] : []);
    
    if (targetIds.length === 0) {
      return res.status(400).json({ error: 'Bad Request', message: 'Please select at least one Purohit (up to 3) to request quotations from.' });
    }

    const createdQuotes = [];
    for (const pid of targetIds) {
      const priest = await dbGet("SELECT name FROM purohits WHERE id = ?", [pid]);
      const priestName = priest ? priest.name : 'Unknown Acharya';
      
      const id = 'qt-' + Math.random().toString(36).substr(2, 9);
      await dbRun(
        `INSERT INTO puja_quotes (id, user_id, user_name, purohit_id, purohit_name, puja_type, preferred_date, details, quote_amount, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'Pending Quote')`,
        [id, req.user.id, req.user.name, pid, priestName, pujaType, preferredDate, details]
      );
      createdQuotes.push({ id, purohitId: pid, purohitName: priestName });

      // Send alert to Admin
      const notifId = 'notif-' + Math.random().toString(36).substr(2, 9);
      await dbRun(
        `INSERT INTO notifications (id, title, \`desc\`, \`read\`) VALUES (?, ?, ?, 0)`,
        [notifId, `New Custom Quote Request`, `${req.user.name} requested custom quote from ${priestName} for ${pujaType} on ${preferredDate}.`]
      );
    }

    res.status(201).json({ 
      message: `Quotation requests submitted successfully to ${targetIds.length} Purohit(s)!`, 
      quotes: createdQuotes 
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// 4. Devotee View Own Quotation Requests
app.get('/api/quotes/my', authenticateToken, async (req, res) => {
  try {
    const quotes = await dbQuery(`
      SELECT q.*, u.phone as priest_phone, u.email as priest_email 
      FROM puja_quotes q
      LEFT JOIN users u ON q.purohit_id = u.id AND (q.status = 'Accepted' OR q.status = 'accepted')
      WHERE q.user_id = ? 
      ORDER BY q.created_at DESC
    `, [req.user.id]);
    res.json(quotes);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// 5. Devotee Accept Quotation: Converts quote to confirmed booking and increments bookings_count!
// Auto-rejects other sibling bids for the same puja type and date, and returns priest's phone/email coordinate details.
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
      { id: 'item-2', name: 'Pure Pasupu (Turmeric Powder) - 100g', quantity: 1, price: 149, isStoreProduct: true, storeProductId: 'p1' },
      { id: 'item-3', name: 'Pure Kumkum - 100g', quantity: 1, price: 129, isStoreProduct: true, storeProductId: 'p2' }
    ];

    await dbRun(
      `INSERT INTO purohit_bookings (id, purohit_id, user_id, pooja_type, booking_date, time_slot, address, status, items, secure_deposit)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Confirmed', ?, 0)`,
      [bookingId, purohitId, req.user.id, `${quote.puja_type} (Custom quote accepted ₹${quote.quote_amount})`, bookingDate, timeSlot, address, JSON.stringify(defaultChecklist)]
    );

    // Increment bookings count
    await dbRun("UPDATE purohits SET bookings_count = bookings_count + 1 WHERE id = ?", [purohitId]);

    // Update quote status for accepted
    await dbRun("UPDATE puja_quotes SET status = 'Accepted' WHERE id = ?", [req.params.id]);

    // Auto-reject competing sibling bids for the same devotee, puja type, and preferred date
    await dbRun(
      `UPDATE puja_quotes 
       SET status = 'Rejected' 
       WHERE user_id = ? AND puja_type = ? AND preferred_date = ? AND id != ?`,
      [req.user.id, quote.puja_type, quote.preferred_date, req.params.id]
    );

    // Fetch Priest Contact coordinates from users table so devotee can contact them directly on WhatsApp
    const priestUser = await dbGet("SELECT phone, email FROM users WHERE id = ?", [purohitId]);
    const priestPhone = priestUser ? priestUser.phone : 'Not available';
    const priestEmail = priestUser ? priestUser.email : 'Not available';

    // Send Alert to admin
    const notifId = 'notif-' + Math.random().toString(36).substr(2, 9);
    await dbRun(
      `INSERT INTO notifications (id, title, \`desc\`, \`read\`) VALUES (?, ?, ?, 0)`,
      [notifId, `Custom Quote Accepted`, `${req.user.name} accepted quote ₹${quote.quote_amount} for ${quote.puja_type} booking ${bookingId}.`]
    );

    res.json({ 
      message: 'Quotation accepted! Booking generated and scheduled successfully.', 
      bookingId,
      priestContact: {
        phone: priestPhone,
        email: priestEmail
      }
    });
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

// 7. Priest View Quotation Requests (strictly matching assigned priest ID so they never see other priest's quotes)
app.get('/api/purohit/quotes', authenticateToken, async (req, res) => {
  if (req.user.role !== 'purohit') {
    return res.status(403).json({ error: 'Forbidden', message: 'Only Purohits can bid on quotations.' });
  }
  try {
    const quotes = await dbQuery(
      `SELECT q.*, u.phone as devotee_phone, u.email as devotee_email 
       FROM puja_quotes q
       LEFT JOIN users u ON q.user_id = u.id AND (q.status = 'Accepted' OR q.status = 'accepted')
       WHERE q.purohit_id = ? 
       ORDER BY q.created_at DESC`,
      [req.user.id]
    );
    res.json(quotes);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

// 8. Priest Send Quotation Bid (only can bid on their assigned quote)
app.post('/api/purohit/quotes/:id/send', authenticateToken, async (req, res) => {
  if (req.user.role !== 'purohit') {
    return res.status(403).json({ error: 'Forbidden', message: 'Only Purohits can bid on quotations.' });
  }
  const { quoteAmount } = req.body;
  if (!quoteAmount || Number(quoteAmount) <= 0) {
    return res.status(400).json({ error: 'Bad Request', message: 'Valid quotation bid amount in Rupees (₹) is required.' });
  }
  try {
    const quote = await dbGet("SELECT * FROM puja_quotes WHERE id = ? AND purohit_id = ?", [req.params.id, req.user.id]);
    if (!quote) {
      return res.status(404).json({ error: 'Not Found', message: 'Quote request not found or assigned to another priest.' });
    }

    await dbRun(
      `UPDATE puja_quotes 
       SET quote_amount = ?, status = 'Quote Sent'
       WHERE id = ?`,
      [Number(quoteAmount), req.params.id]
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
    } else {
      // Send notification for public query replies as well!
      try {
        const devotee = await dbGet("SELECT * FROM users WHERE name = ?", [query.user_name]);
        if (devotee) {
          if (devotee.email) {
            const subject = `✦ Satsang Doubt Resolved: ${query.category} ✦`;
            const htmlContent = `
              <div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #C9943A; border-radius: 12px; max-width: 600px; background-color: #FCFBF8; margin: auto;">
                <h2 style="color: #5C0A20; text-align: center; border-bottom: 2px solid #C9943A; padding-bottom: 12px; font-family: 'Georgia', serif;">gurupadukam.com</h2>
                <p style="font-size: 15px; color: #1A1A1A;">Dear Devotee (<strong>${devotee.name}</strong>),</p>
                <p style="font-size: 14px; color: #333; line-height: 1.6;">Your spiritual query on the public Satsang Board has been resolved by our verified Acharya.</p>
                
                <div style="background-color: rgba(92,10,32,0.05); padding: 15px; border-left: 4px solid #5C0A20; margin: 15px 0;">
                  <p style="font-size: 13px; font-weight: bold; margin: 0; color: #5C0A20;">Your Question:</p>
                  <p style="font-size: 13px; font-style: italic; margin: 5px 0 0 0; color: #555;">"${query.question}"</p>
                </div>
                
                <div style="background-color: rgba(201,148,58,0.1); padding: 15px; border-left: 4px solid #C9943A; margin: 15px 0;">
                  <p style="font-size: 13px; font-weight: bold; margin: 0; color: #C9943A;">Acharya Reply (${req.user.name}):</p>
                  <p style="font-size: 13px; margin: 5px 0 0 0; color: #222;">"${replyContent}"</p>
                </div>

                <p style="font-size: 13px; color: #333; line-height: 1.5;">You can view the full thread and reply on the live forum.</p>
                <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
                <p style="font-size: 10px; color: #999; text-align: center;">© gurupadukam.com. All rights reserved.</p>
              </div>
            `;
            sendEmailNotification(devotee.email, subject, htmlContent);
          }
          if (devotee.phone) {
            const smsText = `✦ Gurupadukam Satsang ✦\nRespected Devotee, your public doubt "${query.question.slice(0, 30)}..." has been answered by ${req.user.name}.\n\nReply: "${replyContent.slice(0, 100)}..."`;
            sendSMSNotification(devotee.phone, smsText);
          }
        }
      } catch (notifErr) {
        console.error('[Notification Dispatch Failed on Public Satsang Reply]:', notifErr.message);
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
  if (!reviewText || reviewText.trim().length === 0) {
    return res.status(400).json({ error: 'Bad Request', message: 'Review description is mandatory.' });
  }

  try {
    const booking = await dbGet(
      "SELECT id FROM purohit_bookings WHERE id = ? AND user_id = ? AND purohit_id = ?",
      [bookingId, req.user.id, purohitId]
    );
    if (!booking) {
      return res.status(403).json({ error: 'Forbidden', message: 'Only the devotee who booked this priest can submit a review.' });
    }

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

// Priest Send Puja Items list directly to Devotee's Phone via simulated SMS
app.post('/api/purohits/bookings/:bookingId/send-items', authenticateToken, async (req, res) => {
  try {
    const booking = await dbGet("SELECT * FROM purohit_bookings WHERE id = ?", [req.params.bookingId]);
    if (!booking) {
      return res.status(404).json({ error: 'Not Found', message: 'Booking not found.' });
    }
    if (req.user.role !== 'purohit' && req.user.role !== 'admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Forbidden', message: 'Only authorized purohits can trigger this action.' });
    }

    const devotee = await dbGet("SELECT phone, name FROM users WHERE id = ?", [booking.user_id]);
    if (!devotee) {
      return res.status(404).json({ error: 'Not Found', message: 'Devotee not found.' });
    }

    // Prepare checklist message text
    let itemsList = [];
    try {
      const parsedItems = JSON.parse(booking.items || '[]');
      itemsList = parsedItems.map(item => `• ${item.name} (${item.quantity}x)`);
    } catch (e) {
      itemsList = ['Checklist parse error'];
    }

    const smsText = `Hari Om ${devotee.name} ji! Your Purohit has reviewed and sent the puja items checklist for your upcoming booking ${booking.id} (${booking.pooja_type}):\n\n${itemsList.join('\n')}\n\nKindly procure these items prior to the rituals. 🌿`;

    await sendSMSNotification(devotee.phone, smsText);

    res.json({ success: true, message: `Puja items checklist successfully sent to Devotee ${devotee.name}'s phone! 🌿` });
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

// Serve frontend compiled client assets directly from Express if they exist
const frontendDistPath = path.join(__dirname, '../frontend/dist');

if (fs.existsSync(frontendDistPath)) {
  app.use(express.static(frontendDistPath));
}

app.use((req, res, next) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/api-proxy') || req.url.startsWith('/ws-proxy')) {
    return next();
  }
  
  if (fs.existsSync(path.join(frontendDistPath, 'index.html'))) {
    res.sendFile(path.join(frontendDistPath, 'index.html'), { dotfiles: 'allow' });
  } else {
    // Elegant API home response suitable for our hybrid plan!
    res.setHeader('Content-Type', 'text/html');
    res.send(`
      <div style="font-family: Arial, sans-serif; text-align: center; padding: 40px 20px; background-color: #FCFBF8; color: #5C0A20; border: 4px double #C9943A; max-width: 480px; margin: 60px auto; border-radius: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.05);">
        <h2 style="margin-bottom: 10px; font-family: 'Cinzel', serif; letter-spacing: 1px;">✦ gurupadukam.com ✦</h2>
        <p style="color: #666; font-size: 13px; line-height: 1.6;">The spiritual portal production API engine is live, active, and securely whitelisted.</p>
        <div style="font-size: 10px; color: #999; margin-top: 25px; border-top: 1px solid #eee; padding-top: 15px;">© ${new Date().getFullYear()} gurupadukam.com. All rights reserved.</div>
      </div>
    `);
  }
});


// ==========================================
// ============ UPGRADE WEBSOCKET ============
// ==========================================

// ✦ DAILY CRON JOB: 24-Hour Priest Booking Reminders ✦
cron.schedule('0 8 * * *', async () => {
  console.log('[Cron] Running daily 24-hour reminder check for Purohit Bookings...');
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    const upcomingBookings = await dbQuery(
      `SELECT b.*, 
              u.email as devotee_email, u.phone as devotee_phone, u.name as devotee_name, 
              p.name as priest_name, 
              pu.email as priest_email, pu.phone as priest_phone
       FROM purohit_bookings b
       JOIN users u ON b.user_id = u.id
       JOIN purohits p ON b.purohit_id = p.id
       LEFT JOIN users pu ON b.purohit_id = pu.id
       WHERE b.booking_date = ? AND b.status = 'Confirmed'`,
      [tomorrowStr]
    );

    for (const booking of upcomingBookings) {
      const { id, pooja_type, time_slot, address, ritual_mode, google_meet_link, devotee_email, devotee_phone, devotee_name, priest_name, priest_email, priest_phone } = booking;
      
      // 1. Send Devotee Reminder
      if (devotee_email) {
        const subject = `✦ Reminder: Your Sacred Pooja (${pooja_type}) is Tomorrow 🌿`;
        const html = `<div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #C9943A; border-radius: 12px; max-width: 600px; background-color: #FCFBF8; margin: auto;">
          <h2 style="color: #5C0A20; text-align: center; border-bottom: 2px solid #C9943A; padding-bottom: 12px; margin-top: 0;">gurupadukam.com</h2>
          <p style="font-size: 15px; color: #1A1A1A; font-weight: bold;">Hari Om ${devotee_name} ji,</p>
          <p style="font-size: 13px; color: #333; line-height: 1.5;">This is a gentle reminder that your <strong>${pooja_type}</strong> with ${priest_name} Acharya is scheduled for tomorrow at <strong>${time_slot}</strong>.</p>
          <div style="margin: 20px 0; background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; padding: 15px; font-size: 12px; line-height: 1.6;">
            <strong>Venue Address:</strong> ${address}
            ${ritual_mode === 'Online' ? `<br><br><strong>Google Meet Link:</strong> <a href="${google_meet_link}" style="color: #5C0A20; font-weight: bold;">Join Google Meet Session</a>` : ''}
          </div>
          <p style="font-size: 13px; color: #333;">Please ensure your family members are ready and the items are prepared. Have a blissful ritual.</p>
        </div>`;
        sendEmailNotification(devotee_email, subject, html);
      }
      if (devotee_phone) {
        sendSMSNotification(devotee_phone, `Hari Om! Reminder: Your ${pooja_type} with ${priest_name} is tomorrow at ${time_slot}. ${ritual_mode === 'Online' ? 'Check email for Meet link.' : ''}`);
      }

      // 2. Send Priest Reminder
      if (priest_email) {
        const subject = `✦ Reminder: You have a ${pooja_type} Booking Tomorrow 🌿`;
        const html = `<div style="font-family: Arial, sans-serif; padding: 25px; border: 2px solid #C9943A; border-radius: 12px; max-width: 600px; background-color: #FCFBF8; margin: auto;">
          <h2 style="color: #5C0A20; text-align: center; border-bottom: 2px solid #C9943A; padding-bottom: 12px; margin-top: 0;">gurupadukam.com</h2>
          <p style="font-size: 15px; color: #1A1A1A; font-weight: bold;">Hari Om ${priest_name} Acharya ji,</p>
          <p style="font-size: 13px; color: #333; line-height: 1.5;">This is a reminder for your upcoming <strong>${pooja_type}</strong> tomorrow at <strong>${time_slot}</strong> with devotee <strong>${devotee_name}</strong>.</p>
          <div style="margin: 20px 0; background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; padding: 15px; font-size: 12px; line-height: 1.6;">
            <strong>Venue Address:</strong> ${address}
            ${ritual_mode === 'Online' ? `<br><br><strong>Google Meet Link:</strong> <a href="${google_meet_link}" style="color: #5C0A20; font-weight: bold;">Join Google Meet Session</a>` : ''}
          </div>
        </div>`;
        sendEmailNotification(priest_email, subject, html);
      }
      if (priest_phone) {
        sendSMSNotification(priest_phone, `Hari Om Acharya ji! Reminder: You have a ${pooja_type} tomorrow at ${time_slot} for ${devotee_name}. Please be prepared.`);
      }
    }
  } catch (e) {
    console.error('[Cron Error]', e.message);
  }
});

// --- 9. Parinayam Vedic Matrimony APIs ---

const getOptionalUser = (req) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
};

async function getMaskedProfiles(rawProfiles, userId) {
  const viewerProfile = userId ? await dbGet("SELECT id FROM parinayam_profiles WHERE user_id = ? AND is_closed = 0", [userId]) : null;

  let approvedConnectionIds = new Set();
  let connectionMap = new Map();

  if (viewerProfile) {
    const connections = await dbQuery("SELECT * FROM parinayam_connections WHERE from_profile_id = ? OR to_profile_id = ?", [viewerProfile.id, viewerProfile.id]);
    for (const c of connections) {
      const partnerId = c.from_profile_id === viewerProfile.id ? c.to_profile_id : c.from_profile_id;
      connectionMap.set(partnerId, { id: c.id, status: c.status, isSender: c.from_profile_id === viewerProfile.id });
      if (c.status === 'approved') {
        approvedConnectionIds.add(partnerId);
      }
    }
  }

  return rawProfiles.map(p => {
    const isOwner = userId && p.user_id === userId;
    const isApproved = viewerProfile && approvedConnectionIds.has(p.id);
    const conn = connectionMap.get(p.id) || null;

    if (isOwner || isApproved) {
      return {
        ...p,
        isOwner,
        isPhotoMasked: false,
        connectionStatus: isApproved ? 'approved' : null,
        connectionRequest: conn
      };
    } else {
      const suffix = p.id.replace('prn-', '').toUpperCase();
      const alias = (p.gender === 'bride' ? 'Bride' : 'Groom') + ' #GP-PRN-' + suffix;
      return {
        ...p,
        name: alias,
        photo: null,
        isPhotoMasked: true,
        contact_phone: 'Hidden',
        contact_email: 'Hidden',
        isOwner: false,
        connectionStatus: conn ? conn.status : 'none',
        connectionRequest: conn
      };
    }
  });
}

app.get('/api/parinayam/profiles', async (req, res) => {
  try {
    const userPayload = getOptionalUser(req);
    const userId = userPayload ? userPayload.id : null;
    const rawProfiles = await dbQuery("SELECT * FROM parinayam_profiles WHERE is_active = 1 AND is_closed = 0 ORDER BY created_at DESC");
    const masked = await getMaskedProfiles(rawProfiles, userId);
    res.json(masked);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.get('/api/parinayam/my-profile', authenticateToken, async (req, res) => {
  try {
    const profile = await dbGet("SELECT * FROM parinayam_profiles WHERE user_id = ?", [req.user.id]);
    res.json(profile || null);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/parinayam/profiles/close', authenticateToken, async (req, res) => {
  try {
    const profile = await dbGet("SELECT id FROM parinayam_profiles WHERE user_id = ?", [req.user.id]);
    if (!profile) {
      return res.status(404).json({ error: 'Not Found', message: 'Profile not found.' });
    }
    await dbRun("UPDATE parinayam_profiles SET is_closed = 1 WHERE id = ?", [profile.id]);
    res.json({ success: true, message: '✦ Your Parinayam profile has been marked as fulfilled & closed. 💍 ✦' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.get('/api/parinayam/requests', authenticateToken, async (req, res) => {
  try {
    const userProfile = await dbGet("SELECT id FROM parinayam_profiles WHERE user_id = ?", [req.user.id]);
    if (!userProfile) {
      return res.json({ sent: [], received: [] });
    }

    const sent = await dbQuery(
      `SELECT c.*, p.gender, p.rasi, p.nakshatram, p.gothram, p.id as profile_id, p.name as raw_name, p.photo as raw_photo, p.contact_phone as raw_phone, p.contact_email as raw_email
       FROM parinayam_connections c
       JOIN parinayam_profiles p ON c.to_profile_id = p.id
       WHERE c.from_profile_id = ?`,
      [userProfile.id]
    );

    const received = await dbQuery(
      `SELECT c.*, p.gender, p.rasi, p.nakshatram, p.gothram, p.id as profile_id, p.name as raw_name, p.photo as raw_photo, p.contact_phone as raw_phone, p.contact_email as raw_email
       FROM parinayam_connections c
       JOIN parinayam_profiles p ON c.from_profile_id = p.id
       WHERE c.to_profile_id = ?`,
      [userProfile.id]
    );

    const formatRequest = (r) => {
      const isApproved = r.status === 'approved';
      const suffix = r.profile_id.replace('prn-', '').toUpperCase();
      const alias = (r.gender === 'bride' ? 'Bride' : 'Groom') + ' #GP-PRN-' + suffix;
      return {
        id: r.id,
        from_profile_id: r.from_profile_id,
        to_profile_id: r.to_profile_id,
        status: r.status,
        created_at: r.created_at,
        profile: {
          id: r.profile_id,
          name: isApproved ? r.raw_name : alias,
          photo: isApproved ? r.raw_photo : null,
          isPhotoMasked: !isApproved,
          contact_phone: isApproved ? r.raw_phone : 'Hidden',
          contact_email: isApproved ? r.raw_email : 'Hidden',
          gender: r.gender,
          rasi: r.rasi,
          nakshatram: r.nakshatram,
          gothram: r.gothram
        }
      };
    };

    res.json({
      sent: sent.map(formatRequest),
      received: received.map(formatRequest)
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/parinayam/requests', authenticateToken, async (req, res) => {
  const { toProfileId } = req.body;
  if (!toProfileId) {
    return res.status(400).json({ error: 'Bad Request', message: 'Target profile ID is required.' });
  }

  try {
    const userProfile = await dbGet("SELECT id FROM parinayam_profiles WHERE user_id = ? AND is_closed = 0", [req.user.id]);
    if (!userProfile) {
      return res.status(400).json({ error: 'Bad Request', message: 'You must create an active Parinayam profile first to request connections.' });
    }

    if (userProfile.id === toProfileId) {
      return res.status(400).json({ error: 'Bad Request', message: 'You cannot connect with your own profile.' });
    }

    const target = await dbGet("SELECT id FROM parinayam_profiles WHERE id = ? AND is_active = 1 AND is_closed = 0", [toProfileId]);
    if (!target) {
      return res.status(404).json({ error: 'Not Found', message: 'Target profile not found or is closed.' });
    }

    const existing = await dbGet(
      "SELECT id FROM parinayam_connections WHERE (from_profile_id = ? AND to_profile_id = ?) OR (from_profile_id = ? AND to_profile_id = ?)",
      [userProfile.id, toProfileId, toProfileId, userProfile.id]
    );

    if (existing) {
      return res.status(400).json({ error: 'Bad Request', message: 'A connection request already exists between these profiles.' });
    }

    const connectionId = 'conn-' + Math.random().toString(36).substr(2, 9);
    await dbRun(
      "INSERT INTO parinayam_connections (id, from_profile_id, to_profile_id, status) VALUES (?, ?, ?, 'pending')",
      [connectionId, userProfile.id, toProfileId]
    );

    res.status(201).json({ success: true, message: '✦ Connection request sent successfully! ✦' });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.put('/api/parinayam/requests/:requestId', authenticateToken, async (req, res) => {
  const { requestId } = req.params;
  const { status } = req.body;

  if (!['approved', 'declined'].includes(status)) {
    return res.status(400).json({ error: 'Bad Request', message: 'Status must be approved or declined.' });
  }

  try {
    const userProfile = await dbGet("SELECT id FROM parinayam_profiles WHERE user_id = ?", [req.user.id]);
    if (!userProfile) {
      return res.status(403).json({ error: 'Forbidden', message: 'You do not have a Parinayam profile.' });
    }

    const connection = await dbGet("SELECT * FROM parinayam_connections WHERE id = ?", [requestId]);
    if (!connection) {
      return res.status(404).json({ error: 'Not Found', message: 'Connection request not found.' });
    }

    if (connection.to_profile_id !== userProfile.id) {
      return res.status(403).json({ error: 'Forbidden', message: 'You can only approve or decline requests sent to you.' });
    }

    await dbRun("UPDATE parinayam_connections SET status = ? WHERE id = ?", [status, requestId]);
    res.json({ success: true, message: `✦ Connection request has been ${status}. ✦` });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/parinayam/profiles', authenticateToken, async (req, res) => {
  const { name, gender, dob, tob, pob, gothram, nakshatram, rasi, padam, education, profession, income, loans, about, photo, contact_phone, contact_email } = req.body;

  if (!name || !gender || !dob || !gothram || !nakshatram || !rasi) {
    return res.status(400).json({ error: 'Bad Request', message: 'Name, Gender, DOB, Gothram, Nakshatram, and Rasi are required.' });
  }

  try {
    const profileId = 'prn-' + Math.random().toString(36).substr(2, 9);
    
    await dbRun(
      `INSERT INTO parinayam_profiles (id, user_id, name, gender, dob, tob, pob, gothram, nakshatram, rasi, padam, education, profession, income, loans, about, photo, contact_phone, contact_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        profileId,
        req.user.id,
        name,
        gender,
        dob,
        tob || '',
        pob || '',
        gothram,
        nakshatram,
        rasi,
        padam ? Number(padam) : null,
        education || '',
        profession || '',
        income ? Number(income) : 0,
        loans || 'None',
        about || '',
        photo || 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&q=80&w=400',
        contact_phone || '',
        contact_email || ''
      ]
    );

    res.status(201).json({ success: true, message: '✦ Your Parinayam Matrimonial Profile has been published successfully! ✦', profileId });
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

app.post('/api/parinayam/match', async (req, res) => {
  const { gender, gothram, rasi, nakshatram, minIncome, maxLoans } = req.body;

  if (!gender || !gothram || !rasi || !nakshatram) {
    return res.status(400).json({ error: 'Bad Request', message: 'Your gender, gothram, rasi, and nakshatram are required for matchmaking.' });
  }

  try {
    const userPayload = getOptionalUser(req);
    const userId = userPayload ? userPayload.id : null;

    const targetGender = gender === 'bride' ? 'bridegroom' : 'bride';
    
    let query = "SELECT * FROM parinayam_profiles WHERE gender = ? AND is_active = 1 AND is_closed = 0";
    const params = [targetGender];

    if (minIncome) {
      query += " AND income >= ?";
      params.push(Number(minIncome));
    }

    if (maxLoans === 'noLoans') {
      query += " AND (loans IS NULL OR loans = '' OR loans = 'None' OR loans = 'no' OR loans = 'No')";
    }

    const candidates = await dbQuery(query, params);

    const matches = candidates.map(c => {
      const compat = calculateVedicCompatibility({ gothram, rasi, nakshatram }, c);
      return {
        ...c,
        gunaScore: compat.gunaScore,
        matchPercentage: compat.matchPercentage,
        compatibilityLevel: compat.compatibilityLevel,
        compatibilityNotes: compat.notes
      };
    });

    matches.sort((a, b) => b.matchPercentage - a.matchPercentage);

    const masked = await getMaskedProfiles(matches, userId);
    res.json(masked);
  } catch (err) {
    res.status(500).json({ error: 'Internal Error', message: err.message });
  }
});

function calculateVedicCompatibility(searcher, match) {
  const fire = ['Mesha', 'Simha', 'Dhanus'];
  const earth = ['Vrishabha', 'Kanya', 'Makara'];
  const air = ['Mithuna', 'Tula', 'Kumbha'];
  const water = ['Karka', 'Vrishchika', 'Meena'];

  const getElement = (r) => {
    if (fire.includes(r)) return 'fire';
    if (earth.includes(r)) return 'earth';
    if (air.includes(r)) return 'air';
    if (water.includes(r)) return 'water';
    return 'space';
  };

  let gunaScore = 18;
  let notes = [];

  if (searcher.gothram && match.gothram && searcher.gothram.toLowerCase() === match.gothram.toLowerCase()) {
    gunaScore -= 6;
    notes.push('⚠️ Same Gothram detected (Gothra Sagothra Dosha).');
  } else {
    gunaScore += 2;
  }

  const sEl = getElement(searcher.rasi);
  const mEl = getElement(match.rasi);

  if (sEl === mEl) {
    gunaScore += 8;
    notes.push('✨ Harmonious Rasi Element matching (Same Element).');
  } else if (
    (sEl === 'fire' && mEl === 'air') || (sEl === 'air' && mEl === 'fire') ||
    (sEl === 'earth' && mEl === 'water') || (sEl === 'water' && mEl === 'earth')
  ) {
    gunaScore += 6;
    notes.push('✨ Complementary Rasi Elements (Fire-Air / Earth-Water).');
  } else {
    gunaScore -= 2;
    notes.push('❄️ Neutral/Incompatible Rasi Elements.');
  }

  if (searcher.nakshatram === match.nakshatram) {
    gunaScore += 6;
    notes.push('✨ Same Nakshatram (Janma Nakshatra resonance).');
  } else {
    const val = (searcher.nakshatram.charCodeAt(0) + match.nakshatram.charCodeAt(0)) % 10;
    if (val >= 6) {
      gunaScore += 6;
      notes.push('✨ Auspicious Nakshatra Porutham (Tara/Yoni resonance).');
    } else if (val >= 3) {
      gunaScore += 4;
      notes.push('👍 Moderate Nakshatra compatibility.');
    } else {
      gunaScore += 1;
      notes.push('❄️ Lower Nakshatra matching score.');
    }
  }

  gunaScore = Math.max(12, Math.min(36, gunaScore));
  const matchPercentage = Math.round((gunaScore / 36) * 100);

  return {
    gunaScore,
    matchPercentage,
    compatibilityLevel: matchPercentage >= 80 ? 'Highly Compatible (Uttama)' : matchPercentage >= 60 ? 'Compatible (Madhyama)' : 'Averagely Compatible (Adhama)',
    notes
  };
}

await dbInitPromise;
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
