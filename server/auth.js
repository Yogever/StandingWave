import crypto from 'node:crypto';
import { config } from './config.js';

const COOKIE_NAME = 'sw_session';

// Key derived from the password by default so sessions survive restarts.
const secret =
  config.sessionSecret ||
  crypto.createHash('sha256').update(`standingwave:${config.appPassword}`).digest('hex');

function sign(payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function makeSessionCookie() {
  const expires = Date.now() + config.sessionDays * 24 * 60 * 60 * 1000;
  const payload = String(expires);
  return {
    name: COOKIE_NAME,
    value: `${payload}.${sign(payload)}`,
    maxAgeMs: config.sessionDays * 24 * 60 * 60 * 1000,
  };
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isAuthenticated(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!raw) return false;
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return false;
  const payload = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expected = sign(payload);
  if (mac.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  return Number(payload) > Date.now();
}

// Simple in-memory rate limit for login attempts.
const attempts = new Map(); // ip -> { count, resetAt }
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

export function checkLoginAllowed(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 0, resetAt: now + WINDOW_MS });
    return true;
  }
  return entry.count < MAX_ATTEMPTS;
}

export function recordLoginFailure(ip) {
  const entry = attempts.get(ip);
  if (entry) entry.count += 1;
}

export function verifyPassword(candidate) {
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(config.appPassword);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
