import { createServer } from 'node:http';
import dgram from 'node:dgram';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostname = process.env.HOST || '0.0.0.0';
const port = parseInt(process.env.PORT, 10) || 3000;

// Configuration
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE, 10) || 50 * 1024 * 1024; // 50MB default
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100;
const ALLOWED_EXTENSIONS = process.env.ALLOWED_EXTENSIONS?.split(',') || null; // null = allow all

// Rate limiting store
const rateLimitStore = new Map();

// Logging utility
function log(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`);
}

// Rate limiter
function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimitStore.get(ip);
  
  if (!record || now - record.windowStart > RATE_LIMIT_WINDOW) {
    rateLimitStore.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  
  if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }
  
  record.count++;
  return true;
}

// Clean up old rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitStore) {
    if (now - record.windowStart > RATE_LIMIT_WINDOW) {
      rateLimitStore.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW);

// Upload directory
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

function getOutboundIP(callback) {
  const socket = dgram.createSocket('udp4');
  socket.connect(12345, '10.254.254.254', function() {
    const address = socket.address();
    socket.close();
    callback(address.address);
  });
  socket.on('error', function() {
    callback('127.0.0.1');
  });
}

// Sanitize filename - remove dangerous characters
function sanitizeFilename(filename) {
  return filename
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') // Remove invalid chars
    .replace(/\.\./g, '_') // Prevent directory traversal
    .replace(/^\s+|\s+$/g, '') // Trim whitespace
    .substring(0, 255); // Limit length
}

// Validate file extension
function isAllowedExtension(filename) {
  if (!ALLOWED_EXTENSIONS) return true;
  const ext = path.extname(filename).toLowerCase().slice(1);
  return ALLOWED_EXTENSIONS.includes(ext);
}

function parseMultipartData(buffer, boundary) {
  const parts = [];
  // Handle quoted boundary
  const cleanBoundary = boundary.replace(/^"(.*)"$/, '$1');
  const boundaryBuffer = Buffer.from('--' + cleanBoundary);
  let start = buffer.indexOf(boundaryBuffer);
  
  while (start !== -1) {
    start += boundaryBuffer.length + 2; // Skip boundary and CRLF
    const end = buffer.indexOf(boundaryBuffer, start);
    if (end === -1) break;
    
    const partData = buffer.slice(start, end - 2); // Remove trailing CRLF
    const headerEnd = partData.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    
    const headers = partData.slice(0, headerEnd).toString();
    const content = partData.slice(headerEnd + 4);
    
    const filenameMatch = headers.match(/filename="(.+?)"/);
    const nameMatch = headers.match(/name="(.+?)"/);
    
    if (filenameMatch && nameMatch) {
      parts.push({
        name: nameMatch[1],
        filename: filenameMatch[1],
        data: content
      });
    }
    
    start = end;
  }
  
  return parts;
}

function getContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const types = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.txt': 'text/plain'
  };
  return types[ext] || 'application/octet-stream';
}

const myServer = createServer((req, res) => {
  const startTime = Date.now();
  const clientIP = req.socket.remoteAddress || 'unknown';
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  // Log incoming request
  log('info', `${req.method} ${url.pathname}`, { ip: clientIP });
  
  // Rate limiting
  if (!checkRateLimit(clientIP)) {
    log('warn', 'Rate limit exceeded', { ip: clientIP });
    res.statusCode = 429;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Retry-After', '60');
    res.end(JSON.stringify({ error: 'Too many requests. Please try again later.' }));
    return;
  }
  
  // Log response when finished
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    log('info', `${req.method} ${url.pathname} ${res.statusCode}`, { duration: `${duration}ms`, ip: clientIP });
  });
  
  // Serve index.html
  if (url.pathname === '/' && req.method === 'GET') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain');
        res.end('index.html not found');
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html;charset=UTF-8');
      res.end(data);
    });
    return;
  }
  
  // List files
  if (url.pathname === '/api/files' && req.method === 'GET') {
    (async () => {
      try {
        const files = await fsPromises.readdir(uploadDir);
        const fileStats = await Promise.all(
          files.map(async (file) => {
            const stats = await fsPromises.stat(path.join(uploadDir, file));
            return {
              name: file,
              size: stats.size,
              modified: stats.mtime
            };
          })
        );
        
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(JSON.stringify(fileStats));
      } catch (err) {
        log('error', 'Failed to read directory', { error: err.message });
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Failed to read directory' }));
      }
    })();
    return;
  }
  
  // Upload files
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    // Check content-length header for early rejection
    const contentLength = parseInt(req.headers['content-length'], 10) || 0;
    if (contentLength > MAX_FILE_SIZE) {
      log('warn', 'Upload rejected: file too large', { size: contentLength, max: MAX_FILE_SIZE });
      res.statusCode = 413;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` }));
      return;
    }
    
    let body = [];
    let receivedBytes = 0;
    
    req.on('error', (err) => {
      log('error', 'Upload request error', { error: err.message });
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Upload failed' }));
    });
    
    req.on('data', chunk => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_FILE_SIZE) {
        req.destroy();
        res.statusCode = 413;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` }));
        return;
      }
      body.push(chunk);
    });
    
    req.on('end', async () => {
      try {
        const buffer = Buffer.concat(body);
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(.+)/);
        
        if (!boundaryMatch) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Invalid content type' }));
          return;
        }
        
        const boundary = boundaryMatch[1];
        const files = parseMultipartData(buffer, boundary);
        const savedFiles = [];
        const errors = [];
        
        for (const file of files) {
          const safeName = sanitizeFilename(path.basename(file.filename));
          
          if (!safeName || safeName === '.' || safeName === '..') {
            errors.push({ filename: file.filename, error: 'Invalid filename' });
            continue;
          }
          
          if (!isAllowedExtension(safeName)) {
            errors.push({ filename: file.filename, error: 'File type not allowed' });
            continue;
          }
          
          const filepath = path.join(uploadDir, safeName);
          await fsPromises.writeFile(filepath, file.data);
          savedFiles.push(safeName);
          log('info', 'File uploaded', { filename: safeName, size: file.data.length });
        }
        
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, files: savedFiles, errors }));
      } catch (err) {
        log('error', 'Upload processing error', { error: err.message });
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Failed to process upload' }));
      }
    });
    
    return;
  }
  
  // Download file
  if (url.pathname.startsWith('/api/download/') && req.method === 'GET') {
    const filename = decodeURIComponent(url.pathname.replace('/api/download/', ''));
    const safeName = path.basename(filename);
    const filepath = path.join(uploadDir, safeName);
    
    // Verify file is within upload directory (prevent path traversal)
    if (!filepath.startsWith(uploadDir)) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Access denied' }));
      return;
    }
    
    fs.stat(filepath, (err, stats) => {
      if (err) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'File not found' }));
        return;
      }
      
      // Generate ETag from file stats
      const etag = crypto.createHash('md5').update(`${stats.mtime.getTime()}-${stats.size}`).digest('hex');
      
      // Check if client has cached version
      if (req.headers['if-none-match'] === etag) {
        res.statusCode = 304;
        res.end();
        return;
      }
      
      res.statusCode = 200;
      res.setHeader('Content-Type', getContentType(safeName));
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      
      // Stream the file instead of loading into memory
      const stream = fs.createReadStream(filepath);
      stream.on('error', (streamErr) => {
        log('error', 'Stream error', { error: streamErr.message, file: safeName });
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'Failed to read file' }));
        }
      });
      stream.pipe(res);
    });
    return;
  }
  
  // Delete file
  if (url.pathname.startsWith('/api/delete/') && req.method === 'DELETE') {
    const filename = decodeURIComponent(url.pathname.replace('/api/delete/', ''));
    const safeName = path.basename(filename);
    const filepath = path.join(uploadDir, safeName);
    
    // Verify file is within upload directory (prevent path traversal)
    if (!filepath.startsWith(uploadDir)) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Access denied' }));
      return;
    }
    
    fs.unlink(filepath, (err) => {
      if (err) {
        log('warn', 'Delete failed', { file: safeName, error: err.message });
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'File not found' }));
        return;
      }
      
      log('info', 'File deleted', { filename: safeName });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }
  
  // 404 for unknown routes
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Not Found');
});


myServer.listen(port, hostname, () => {
  getOutboundIP(ip => {
    log('info', `Server running at http://${ip}:${port}`);
    log('info', `Configuration`, {
      maxFileSize: `${MAX_FILE_SIZE / 1024 / 1024}MB`,
      rateLimit: `${RATE_LIMIT_MAX_REQUESTS} requests per ${RATE_LIMIT_WINDOW / 1000}s`,
      allowedExtensions: ALLOWED_EXTENSIONS || 'all'
    });
  });
});

let shutdownTimer = null;

const gracefulShutdown = function (signal) {
  log('info', `Received ${signal}, starting graceful shutdown`);
  
  // Set timeout for forced shutdown
  shutdownTimer = setTimeout(() => {
    log('error', 'Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10 * 1000);
  
  myServer.close(() => {
    log('info', 'Server closed successfully');
    clearTimeout(shutdownTimer);
    process.exit(0);
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
