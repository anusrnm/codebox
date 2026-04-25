#!/usr/bin/env node

import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const VERSION = '0.1.0';

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

let beforeLogHook = null;

function setBeforeLogHook(fn) {
  beforeLogHook = fn;
}

function parseBool(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  const normalized = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parseNumber(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : defaultValue;
}

function parseDurationMs(input, defaultMs = 0) {
  if (!input) {
    return defaultMs;
  }
  const text = String(input).trim().toLowerCase();
  if (/^\d+$/.test(text)) {
    return Number(text);
  }
  const m = /^(\d+)(ms|s|m|h)$/.exec(text);
  if (!m) {
    return defaultMs;
  }
  const value = Number(m[1]);
  const unit = m[2];
  if (unit === 'ms') return value;
  if (unit === 's') return value * 1000;
  if (unit === 'm') return value * 60_000;
  if (unit === 'h') return value * 3_600_000;
  return defaultMs;
}

const ARG_VALUE_PARSERS = {
  '--host':             (v, o) => { o.hosts = v; },
  '--port':             (v, o) => { o.port = parseNumber(v, o.port); },
  '--username':         (v, o) => { o.username = v; },
  '--password':         (v, o) => { o.password = v; },
  '--queue':            (v, o) => { o.queue = v; },
  '--topic':            (v, o) => { o.topic = v; },
  '--vhost':            (v, o) => { o.vhost = v; },
  '--subscription-id':  (v, o) => { o.subscriptionId = v; },
  '--ack-mode':         (v, o) => { o.ackMode = v; },
  '--output':           (v, o) => { o.output = v; },
  '--max-messages':     (v, o) => { o.maxMessages = parseNumber(v, o.maxMessages); },
  '--duration':         (v, o) => { o.durationMs = parseDurationMs(v, o.durationMs); },
  '--stats-interval':   (v, o) => { o.statsIntervalMs = parseDurationMs(v, o.statsIntervalMs); },
  '--exclude-fields':   (v, o) => { o.excludeFields = v; },
  '--reconnect-delay':  (v, o) => { o.reconnectDelayMs = parseDurationMs(v, o.reconnectDelayMs); },
  '--heartbeat-out':    (v, o) => { o.heartbeatOutgoingMs = parseNumber(v, o.heartbeatOutgoingMs); },
  '--heartbeat-in':     (v, o) => { o.heartbeatIncomingMs = parseNumber(v, o.heartbeatIncomingMs); },
};

const ARG_FLAGS = {
  '--help':         (o) => { o.help = true; },
  '-h':             (o) => { o.help = true; },
  '--tls':          (o) => { o.tls = true; },
  '--no-tls':       (o) => { o.tls = false; },
  '--dry-run':      (o) => { o.dryRun = true; },
  '--no-pretty':    (o) => { o.pretty = false; },
  '--pretty':       (o) => { o.pretty = true; },
  '--stats':        (o) => { o.stats = true; },
  '--no-stats':     (o) => { o.stats = false; },
  '--quiet':        (o) => { o.quiet = true; },
  '--verbose':      (o) => { o.verbose = true; },
  '--no-color':     (o) => { o.noColor = true; },
  '--reconnect':    (o) => { o.reconnect = true; },
  '--no-reconnect': (o) => { o.reconnect = false; },
};

function parseArgs(argv) {
  const options = {
    hosts: process.env.ACTIVEMQ_HOST || 'localhost',
    port: parseNumber(process.env.ACTIVEMQ_PORT, 61613),
    tls: parseBool(process.env.ACTIVEMQ_TLS, false),
    username: process.env.ACTIVEMQ_USERNAME || '',
    password: process.env.ACTIVEMQ_PASSWORD || '',
    queue: process.env.ACTIVEMQ_QUEUE || '',
    topic: process.env.ACTIVEMQ_TOPIC || '',
    vhost: process.env.ACTIVEMQ_VHOST || '',
    subscriptionId: process.env.ACTIVEMQ_SUBSCRIPTION_ID || 'sub-1',
    ackMode: process.env.ACTIVEMQ_ACK_MODE || 'client-individual',
    output: process.env.ACTIVEMQ_OUTPUT_FILE || 'messages.txt',
    maxMessages: parseNumber(process.env.ACTIVEMQ_MAX_MESSAGES, 0),
    durationMs: parseDurationMs(process.env.ACTIVEMQ_DURATION, 0),
    dryRun: parseBool(process.env.ACTIVEMQ_DRY_RUN, false),
    pretty: parseBool(process.env.ACTIVEMQ_PRETTY, true),
    stats: parseBool(process.env.ACTIVEMQ_STATS, true),
    statsIntervalMs: parseDurationMs(process.env.ACTIVEMQ_STATS_INTERVAL, 1000),
    excludeFields: process.env.ACTIVEMQ_EXCLUDE_FIELDS || 'content,activeContent,historyFull,historyDelta,cfLrecs',
    quiet: parseBool(process.env.ACTIVEMQ_QUIET, false),
    verbose: parseBool(process.env.ACTIVEMQ_VERBOSE, false),
    noColor: parseBool(process.env.ACTIVEMQ_NO_COLOR, false),
    reconnect: parseBool(process.env.ACTIVEMQ_RECONNECT, true),
    reconnectDelayMs: parseDurationMs(process.env.ACTIVEMQ_RECONNECT_DELAY, 2000),
    heartbeatOutgoingMs: parseNumber(process.env.ACTIVEMQ_HEARTBEAT_OUT, 10000),
    heartbeatIncomingMs: parseNumber(process.env.ACTIVEMQ_HEARTBEAT_IN, 10000),
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    const flagHandler = ARG_FLAGS[arg];
    if (flagHandler) {
      flagHandler(options);
      continue;
    }

    const valueHandler = ARG_VALUE_PARSERS[arg];
    if (valueHandler) {
      const next = argv[i + 1];
      if (!next) throw new Error(`Unknown or incomplete argument: ${arg}`);
      valueHandler(next, options);
      i += 1;
      continue;
    }

    throw new Error(`Unknown or incomplete argument: ${arg}`);
  }

  return options;
}

function usage() {
  console.log('ActiveMQ STOMP Listener (pure Node, zero npm dependencies)');
  console.log('');
  console.log('Usage:');
  console.log('  node activemq-listener/listener.mjs [options]');
  console.log('');
  console.log('Options:');
  console.log('  --host <hosts>              Comma-separated broker hosts (default: localhost)');
  console.log('  --port <port>               STOMP port (default: 61613)');
  console.log('  --tls | --no-tls            Enable/disable TLS');
  console.log('  --username <name>           STOMP login');
  console.log('  --password <pass>           STOMP passcode');
  console.log('  --queue <names>             Comma-separated queue names, e.g. orders,payments');
  console.log('  --topic <name>              Topic name, e.g. events');
  console.log('  --vhost <name>              STOMP host header');
  console.log('  --subscription-id <id>      Subscription identifier');
  console.log('  --ack-mode <mode>           auto | client | client-individual');
  console.log('  --output <file>             Output file path (default: messages.txt)');
  console.log('  --max-messages <n>          Stop after n messages (0 = unlimited)');
  console.log('  --duration <n[ms|s|m|h]>    Stop after duration');
  console.log('  --dry-run                   Receive but do not write file');
  console.log('  --pretty | --no-pretty      JSON body formatting');
  console.log('  --exclude-fields <csv>      Remove top-level JSON fields');
  console.log('  --stats | --no-stats        Periodic stats output');
  console.log('  --stats-interval <duration> Stats interval, default 1s');
  console.log('  --verbose                   Detailed logs');
  console.log('  --quiet                     Minimal logs');
  console.log('  --no-color                  Disable ANSI colors');
  console.log('  --reconnect | --no-reconnect Enable/disable reconnect');
  console.log('  --reconnect-delay <duration> Delay between retries, default 2s');
  console.log('  --heartbeat-out <ms>        Client heartbeat interval, default 10000');
  console.log('  --heartbeat-in <ms>         Desired server heartbeat, default 10000');
  console.log('  --help                      Show help');
  console.log('');
  console.log('Environment variable equivalents use ACTIVEMQ_* names.');
}

function normalizeSingleDestination(name, type) {
  if (type === 'queue') {
    return name.startsWith('/queue/') ? name : `/queue/${name}`;
  }
  return name.startsWith('/topic/') ? name : `/topic/${name}`;
}

function buildWorkerTargets(options) {
  if (options.queue && options.topic) {
    throw new Error('Specify either --queue or --topic, not both');
  }
  if (!options.queue && !options.topic) {
    throw new Error('Provide a destination with --queue or --topic');
  }

  const type = options.queue ? 'queue' : 'topic';
  const names = (options.queue || options.topic)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const hosts = options.hosts
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (hosts.length === 0) throw new Error('No hosts specified');
  if (names.length === 0) throw new Error('No destinations specified');

  const targets = [];
  for (const host of hosts) {
    for (const name of names) {
      const destination = normalizeSingleDestination(name, type);
      const vhost = options.vhost || host;
      targets.push({ host, destination, vhost, label: `${host}${destination}` });
    }
  }
  return targets;
}

function ts() {
  return new Date().toISOString();
}

function createLogger(options) {
  const useColor = !options.noColor && process.stdout.isTTY;

  function paint(color, msg) {
    if (!useColor) return msg;
    return `${color}${msg}${COLORS.reset}`;
  }

  return {
    info(message) {
      if (beforeLogHook) beforeLogHook();
      if (options.quiet) return;
      console.log(`${paint(COLORS.cyan, '[INFO]')} ${paint(COLORS.gray, ts())} ${message}`);
    },
    warn(message) {
      if (beforeLogHook) beforeLogHook();
      if (options.quiet) return;
      console.warn(`${paint(COLORS.yellow, '[WARN]')} ${paint(COLORS.gray, ts())} ${message}`);
    },
    error(message) {
      if (beforeLogHook) beforeLogHook();
      console.error(`${paint(COLORS.red, '[ERROR]')} ${paint(COLORS.gray, ts())} ${message}`);
    },
    debug(message) {
      if (beforeLogHook) beforeLogHook();
      if (!options.verbose || options.quiet) return;
      console.log(`${paint(COLORS.green, '[DEBUG]')} ${paint(COLORS.gray, ts())} ${message}`);
    }
  };
}

class LineWriter {
  constructor(path) {
    this.stream = fs.createWriteStream(path, { flags: 'a' });
    this.ready = false;
    this.pendingDrain = null;

    this.readyPromise = new Promise((resolve, reject) => {
      this.stream.once('open', () => {
        this.ready = true;
        resolve();
      });
      this.stream.once('error', reject);
    });
  }

  async writeLine(line) {
    await this.readyPromise;
    const text = String(line).replaceAll(/\r?\n/g, ' ');
    const ok = this.stream.write(`${text}\n`);
    if (ok) {
      return;
    }
    if (!this.pendingDrain) {
      this.pendingDrain = new Promise((resolve) => {
        this.stream.once('drain', () => {
          this.pendingDrain = null;
          resolve();
        });
      });
    }
    await this.pendingDrain;
  }

  async close() {
    await this.readyPromise;
    await new Promise((resolve, reject) => {
      this.stream.end((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}

class StompCodec {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) {
      return [];
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    return this.extractFrames();
  }

  skipLeadingNewlines() {
    while (this.buffer.length > 0 && (this.buffer[0] === 0x0a || this.buffer[0] === 0x0d)) {
      this.buffer = this.buffer.slice(1);
    }
  }

  parseCommand() {
    const cmdEnd = this.buffer.indexOf(0x0a);
    if (cmdEnd < 0) return null;
    return { command: this.buffer.slice(0, cmdEnd).toString('utf8').replace(/\r$/, ''), cmdEnd };
  }

  parseHeaders(cmdEnd) {
    const headersMarker = indexOfHeadersEnd(this.buffer, cmdEnd + 1);
    if (!headersMarker) return null;

    const headersRaw = this.buffer
      .slice(cmdEnd + 1, headersMarker.index)
      .toString('utf8')
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter(Boolean);

    const headers = {};
    for (const line of headersRaw) {
      const idx = line.indexOf(':');
      if (idx >= 0) {
        headers[line.slice(0, idx)] = line.slice(idx + 1);
      }
    }
    return { headers, bodyStart: headersMarker.index + headersMarker.length };
  }

  parseBodyWithLength(bodyStart, contentLengthText) {
    const contentLength = Number(contentLengthText);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      throw new Error(`Invalid content-length: ${contentLengthText}`);
    }
    if (this.buffer.length < bodyStart + contentLength + 1) {
      return null;
    }
    const body = this.buffer.slice(bodyStart, bodyStart + contentLength);
    if (this.buffer[bodyStart + contentLength] !== 0x00) {
      throw new Error('Malformed STOMP frame: missing null terminator after content-length body');
    }
    return { body, frameEnd: bodyStart + contentLength + 1 };
  }

  parseBodyUntilNull(bodyStart) {
    const nullIndex = this.buffer.indexOf(0x00, bodyStart);
    if (nullIndex < 0) return null;
    return { body: this.buffer.slice(bodyStart, nullIndex), frameEnd: nullIndex + 1 };
  }

  extractFrames() {
    const frames = [];

    while (this.buffer.length > 0) {
      this.skipLeadingNewlines();
      if (this.buffer.length === 0) break;

      const cmdResult = this.parseCommand();
      if (!cmdResult) break;

      const headerResult = this.parseHeaders(cmdResult.cmdEnd);
      if (!headerResult) break;

      const contentLengthText = headerResult.headers['content-length'];
      const bodyResult = contentLengthText === undefined
        ? this.parseBodyUntilNull(headerResult.bodyStart)
        : this.parseBodyWithLength(headerResult.bodyStart, contentLengthText);
      if (!bodyResult) break;

      frames.push({ command: cmdResult.command, headers: headerResult.headers, body: bodyResult.body });
      this.buffer = this.buffer.slice(bodyResult.frameEnd);
    }

    return frames;
  }
}

function indexOfHeadersEnd(buffer, start) {
  for (let i = start; i < buffer.length - 1; i += 1) {
    if (buffer[i] === 0x0a && buffer[i + 1] === 0x0a) {
      return { index: i, length: 2 };
    }
    if (i < buffer.length - 3 && buffer[i] === 0x0d && buffer[i + 1] === 0x0a && buffer[i + 2] === 0x0d && buffer[i + 3] === 0x0a) {
      return { index: i, length: 4 };
    }
  }
  return null;
}

function serializeFrame(command, headers = {}, body = '') {
  const lines = [command];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) {
      continue;
    }
    lines.push(`${key}:${value}`);
  }
  lines.push('');
  const headerPart = `${lines.join('\n')}\n`;
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  return Buffer.concat([
    Buffer.from(headerPart, 'utf8'),
    bodyBuffer,
    Buffer.from([0x00])
  ]);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseExcludeFields(csv) {
  return new Set(
    String(csv || '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
  );
}

function filterTopLevelFields(value, excluded) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (!excluded.has(k)) {
      out[k] = v;
    }
  }
  return out;
}

function formatJsonPayload(json, pretty) {
  if (pretty) return json;
  return JSON.stringify(json);
}

function isLikelyBinaryPayload(buffer, headers) {
  const contentType = String(headers['content-type'] || headers.contentType || '').toLowerCase();
  if (contentType.startsWith('text/')) {
    return false;
  }
  if (contentType.includes('json') || contentType.includes('xml') || contentType.includes('javascript')) {
    return false;
  }
  if (contentType.includes('octet-stream') || contentType.includes('protobuf') || contentType.includes('avro')) {
    return true;
  }

  if (!buffer || buffer.length === 0) {
    return false;
  }

  let suspicious = 0;
  for (const byte of buffer) {
    if (byte === 0) {
      return true;
    }
    const isTabOrLfOrCr = byte === 9 || byte === 10 || byte === 13;
    const isPrintableAscii = byte >= 32 && byte <= 126;
    if (!isPrintableAscii && !isTabOrLfOrCr) {
      suspicious += 1;
    }
  }

  return suspicious / buffer.length > 0.3;
}

function tryDecodePayload(body, headers) {
  let payload = body;
  let compressed = false;

  const encoding = String(headers['content-encoding'] || headers['contentEncoding'] || '').toLowerCase();
  const hasGzipMagic = body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b;

  if (encoding.includes('gzip') || hasGzipMagic) {
    try {
      payload = zlib.gunzipSync(body);
      compressed = true;
    } catch {
      payload = body;
      compressed = false;
    }
  }

  const isBinary = isLikelyBinaryPayload(payload, headers);
  if (isBinary) {
    return { text: '', compressed, isBinary, base64: payload.toString('base64') };
  }

  const text = payload.toString('utf8');
  return { text, compressed, isBinary, base64: '' };
}

function buildAckHeaders(frameHeaders, subscriptionId) {
  if (frameHeaders.ack) {
    return { id: frameHeaders.ack };
  }
  const headers = {};
  if (frameHeaders['message-id']) {
    headers['message-id'] = frameHeaders['message-id'];
  }
  headers.subscription = frameHeaders.subscription || subscriptionId;
  return headers;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDuration(ms) {
  const sec = Math.floor(ms / 1000);
  const s = sec % 60;
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

async function runConnectionLoop(options, logger) {
  const excludedFields = parseExcludeFields(options.excludeFields);
  const targets = buildWorkerTargets(options);
  const stats = {
    startedAt: Date.now(),
    reconnects: 0,
    messagesReceived: 0,
    messagesProcessed: 0,
    errors: 0,
    bytesReceived: 0,
    compressedMessages: 0
  };

  const writer = options.dryRun ? null : new LineWriter(options.output);

  let stopRequested = false;
  let statsTimer = null;
  let durationTimer = null;
  const activeDisconnects = new Set();
  const inlineStatsEnabled = process.stdout.isTTY && !options.quiet;
  let inlineStatsWidth = 0;

  function clearInlineStats() {
    if (!inlineStatsEnabled || inlineStatsWidth <= 0) {
      return;
    }
    process.stdout.write(`\r${' '.repeat(inlineStatsWidth)}\r`);
    inlineStatsWidth = 0;
  }

  function printStats(prefix = '[STATS]') {
    if (!options.stats || options.quiet) return;
    const elapsed = Date.now() - stats.startedAt;
    const rate = elapsed > 0 ? (stats.messagesProcessed * 1000) / elapsed : 0;
    const line = (
      `${prefix} received=${stats.messagesReceived} processed=${stats.messagesProcessed} ` +
      `errors=${stats.errors} bytes=${formatBytes(stats.bytesReceived)} ` +
      `compressed=${stats.compressedMessages} reconnects=${stats.reconnects} ` +
      `rate=${rate.toFixed(2)}/s uptime=${formatDuration(elapsed)}`
    );

    if (prefix === '[STATS]' && inlineStatsEnabled) {
      const padded = line.padEnd(inlineStatsWidth, ' ');
      process.stdout.write(`\r${padded}`);
      inlineStatsWidth = padded.length;
      return;
    }

    clearInlineStats();
    console.log(line);
  }

  function shouldStop() {
    if (stopRequested) return true;
    if (options.maxMessages > 0 && stats.messagesProcessed >= options.maxMessages) {
      return true;
    }
    return false;
  }

  function requestAllDisconnect(reason) {
    stopRequested = true;
    for (const fn of activeDisconnects) {
      try { fn(reason); } catch { /* ignore */ }
    }
  }

  async function onMessage(frame, sendFrame, destination) {
    stats.messagesReceived += 1;
    stats.bytesReceived += frame.body.length;

    const decoded = tryDecodePayload(frame.body, frame.headers);
    if (decoded.compressed) {
      stats.compressedMessages += 1;
    }

    let payload;
    let payloadEncoding;

    if (decoded.isBinary) {
      payload = decoded.base64;
      payloadEncoding = 'base64';
    } else {
      let parsedJson = null;
      try {
        parsedJson = JSON.parse(decoded.text);
        parsedJson = filterTopLevelFields(parsedJson, excludedFields);
      } catch {
        parsedJson = null;
      }

      payload = parsedJson === null
        ? decoded.text
        : formatJsonPayload(parsedJson, options.pretty);
    }

    const outputRecord = {
      timestamp: new Date().toISOString(),
      destination: destination,
      command: frame.command,
      headers: frame.headers,
      payload,
      payloadEncoding
    };

    if (!options.dryRun && writer) {
      await writer.writeLine(JSON.stringify(outputRecord));
    }

    if (options.ackMode !== 'auto') {
      const ackHeaders = buildAckHeaders(frame.headers, options.subscriptionId);
      sendFrame('ACK', ackHeaders);
    }

    stats.messagesProcessed += 1;
  }

  function handleMessageError(err) {
    stats.errors += 1;
    logger.error(`Message processing error: ${err.message}`);
  }

  async function connectAndConsume(target) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let connected = false;
      let incomingHeartbeatMs = 0;
      let incomingHeartbeatTimer = null;
      let outgoingHeartbeatTimer = null;
      let messageQueue = Promise.resolve();

      const codec = new StompCodec();
      const socket = options.tls
        ? tls.connect({ host: target.host, port: options.port, servername: target.host })
        : net.createConnection({ host: target.host, port: options.port });

      let signalHandlersAttached = false;

      function detachSignalHandlers() {
        if (!signalHandlersAttached) {
          return;
        }
        process.removeListener('SIGINT', signalStop);
        process.removeListener('SIGTERM', signalStop);
        signalHandlersAttached = false;
      }

      function cleanup(reason) {
        activeDisconnects.delete(requestDisconnect);
        detachSignalHandlers();
        if (incomingHeartbeatTimer) {
          clearTimeout(incomingHeartbeatTimer);
          incomingHeartbeatTimer = null;
        }
        if (outgoingHeartbeatTimer) {
          clearInterval(outgoingHeartbeatTimer);
          outgoingHeartbeatTimer = null;
        }
        if (!socket.destroyed) {
          socket.destroy();
        }
        if (!settled) {
          settled = true;
          resolve(reason);
        }
      }

      function fail(err) {
        activeDisconnects.delete(requestDisconnect);
        detachSignalHandlers();
        if (incomingHeartbeatTimer) {
          clearTimeout(incomingHeartbeatTimer);
          incomingHeartbeatTimer = null;
        }
        if (outgoingHeartbeatTimer) {
          clearInterval(outgoingHeartbeatTimer);
          outgoingHeartbeatTimer = null;
        }
        if (!socket.destroyed) {
          socket.destroy();
        }
        if (!settled) {
          settled = true;
          reject(err);
        }
      }

      function onHeartbeatTimeout() {
        fail(new Error(`Heartbeat timeout after ${incomingHeartbeatMs}ms`));
      }

      function resetIncomingHeartbeatTimer() {
        if (!incomingHeartbeatMs || incomingHeartbeatMs <= 0) {
          return;
        }
        if (incomingHeartbeatTimer) {
          clearTimeout(incomingHeartbeatTimer);
        }
        incomingHeartbeatTimer = setTimeout(onHeartbeatTimeout, Math.max(incomingHeartbeatMs * 2, 1000));
      }

      function sendFrame(command, headers = {}, body = '') {
        const frame = serializeFrame(command, headers, body);
        socket.write(frame);
      }

      function sendOutgoingHeartbeat() {
        if (!socket.destroyed) {
          socket.write('\n');
        }
      }

      function handleConnectedFrame(frame) {
        connected = true;
        const hb = String(frame.headers['heart-beat'] || '0,0').split(',');
        const sx = Number(hb[0]) || 0;
        const sy = Number(hb[1]) || 0;

        // STOMP 1.2 negotiation:
        // incoming from server: max(client desired receive, server can send), if both non-zero.
        // outgoing to server: max(client can send, server desired receive), if both non-zero.
        incomingHeartbeatMs = options.heartbeatIncomingMs > 0 && sx > 0
          ? Math.max(options.heartbeatIncomingMs, sx)
          : 0;
        const outgoingHeartbeatMs = options.heartbeatOutgoingMs > 0 && sy > 0
          ? Math.max(options.heartbeatOutgoingMs, sy)
          : 0;

        if (outgoingHeartbeatMs > 0) {
          outgoingHeartbeatTimer = setInterval(sendOutgoingHeartbeat, outgoingHeartbeatMs);
        }

        resetIncomingHeartbeatTimer();

        logger.info(`STOMP connected (version=${frame.headers.version || 'unknown'})`);
        logger.debug(`Heartbeat negotiated incoming=${incomingHeartbeatMs}ms outgoing=${outgoingHeartbeatMs}ms`);
        sendFrame('SUBSCRIBE', {
          id: options.subscriptionId,
          destination: target.destination,
          ack: options.ackMode
        });
        logger.info(`Subscribed to ${target.label} with ack mode ${options.ackMode}`);
      }

      async function processMessageAsync(msgFrame) {
        await onMessage(msgFrame, sendFrame, target.destination);
        if (shouldStop()) {
          cleanup('max-messages');
        }
      }

      function processMessage(msgFrame) {
        messageQueue = messageQueue
          .then(processMessageAsync.bind(null, msgFrame))
          .catch(handleMessageError);
      }

      socket.setNoDelay(true);

      socket.once('connect', () => {
        logger.info(`Connected to ${target.host}:${options.port} (${options.tls ? 'TLS' : 'TCP'})`);

        sendFrame('CONNECT', {
          'accept-version': '1.2,1.1',
          host: target.vhost,
          login: options.username || undefined,
          passcode: options.password || undefined,
          'heart-beat': `${options.heartbeatOutgoingMs},${options.heartbeatIncomingMs}`
        });
      });

      socket.on('data', (chunk) => {
        resetIncomingHeartbeatTimer();

        let frames;
        try {
          frames = codec.push(chunk);
        } catch (err) {
          fail(err);
          return;
        }

        for (const frame of frames) {
          if (!frame.command) {
            continue;
          }

          if (frame.command === 'CONNECTED') {
            handleConnectedFrame(frame);
            continue;
          }

          if (frame.command === 'MESSAGE') {
            processMessage(frame);
            continue;
          }

          if (frame.command === 'ERROR') {
            const details = frame.body.toString('utf8');
            fail(new Error(`Broker ERROR frame: ${details || JSON.stringify(frame.headers)}`));
            return;
          }

          if (frame.command === 'RECEIPT') {
            logger.debug(`Received RECEIPT: ${JSON.stringify(frame.headers)}`);
            continue;
          }

          logger.debug(`Ignoring frame: ${frame.command}`);
        }
      });

      socket.once('close', (hadError) => {
        activeDisconnects.delete(requestDisconnect);
        detachSignalHandlers();
        if (!connected) {
          fail(new Error('Socket closed before STOMP CONNECTED frame'));
          return;
        }
        if (!settled) {
          settled = true;
          resolve(hadError ? 'closed-with-error' : 'closed');
        }
      });

      socket.once('error', (err) => {
        fail(err);
      });

      const requestDisconnect = (reason = 'signal') => {
        stopRequested = true;
        try {
          sendFrame('DISCONNECT', { receipt: `disc-${Date.now()}` });
        } catch {
          // Ignore write errors while closing.
        }
        cleanup(reason);
      };

      const signalStop = () => requestDisconnect('signal');

      process.once('SIGINT', signalStop);
      process.once('SIGTERM', signalStop);
      signalHandlersAttached = true;
      activeDisconnects.add(requestDisconnect);
    });
  }

  if (!options.quiet) {
    logger.info(`ActiveMQ STOMP Listener v${VERSION}`);
    const labels = targets.map((t) => t.label).join(', ');
    logger.info(`Targets (${targets.length}): ${labels}`);
    logger.info(`Output: ${options.dryRun ? '(dry-run)' : options.output}`);
  }

  setBeforeLogHook(clearInlineStats);

  if (options.stats) {
    statsTimer = setInterval(() => printStats('[STATS]'), Math.max(options.statsIntervalMs, 200));
  }
  if (options.durationMs > 0) {
    durationTimer = setTimeout(() => {
      logger.info(`Duration limit reached (${options.durationMs}ms)`);
      requestAllDisconnect('duration');
    }, options.durationMs);
  }

  async function runWorker(target) {
    while (!shouldStop()) {
      try {
        const reason = await connectAndConsume(target);
        logger.warn(`[${target.label}] Connection ended (${reason})`);
      } catch (err) {
        stats.errors += 1;
        logger.error(`[${target.label}] Connection error: ${err.message}`);
      }

      if (shouldStop()) break;

      if (!options.reconnect) {
        logger.warn(`[${target.label}] Reconnect disabled; stopping worker`);
        break;
      }

      stats.reconnects += 1;
      logger.info(`[${target.label}] Reconnecting in ${options.reconnectDelayMs}ms...`);
      await wait(Math.max(options.reconnectDelayMs, 100));
    }
  }

  try {
    await Promise.all(targets.map((target) => runWorker(target)));
  } finally {
    setBeforeLogHook(null);
    if (statsTimer) {
      clearInterval(statsTimer);
    }
    if (durationTimer) {
      clearTimeout(durationTimer);
    }
    if (writer) {
      await writer.close();
    }
    printStats('[FINAL]');
    if (!options.dryRun) {
      console.log(`Output file: ${path.resolve(options.output)}`);
    }
  }
}

// Top-level entry point
let options;
let startupOk = true;
try {
  options = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`Argument error: ${err.message}`);
  usage();
  process.exitCode = 1;
  startupOk = false;
}

if (startupOk && options.help) {
  usage();
  startupOk = false;
}

if (startupOk) {
  const validAckModes = new Set(['auto', 'client', 'client-individual']);
  if (!validAckModes.has(options.ackMode)) {
    console.error('Invalid --ack-mode. Allowed: auto, client, client-individual');
    process.exitCode = 1;
    startupOk = false;
  }
}

if (startupOk) {
  const logger = createLogger(options);

  try {
    await runConnectionLoop(options, logger);
  } catch (err) {
    logger.error(err.stack || err.message);
    process.exitCode = 1;
  }
}
