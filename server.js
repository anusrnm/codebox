import { createServer } from 'node:http';
import dgram from 'node:dgram';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostname = '0.0.0.0';
const port = 3000;

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

function parseMultipartData(buffer, boundary) {
  const parts = [];
  const boundaryBuffer = Buffer.from('--' + boundary);
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
  const url = new URL(req.url, `http://${req.headers.host}`);
  
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
    fs.readdir(uploadDir, (err, files) => {
      if (err) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Failed to read directory' }));
        return;
      }
      
      const fileStats = files.map(file => {
        const stats = fs.statSync(path.join(uploadDir, file));
        return {
          name: file,
          size: stats.size,
          modified: stats.mtime
        };
      });
      
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(fileStats));
    });
    return;
  }
  
  // Upload files
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    let body = [];
    
    req.on('data', chunk => {
      body.push(chunk);
    });
    
    req.on('end', () => {
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
      
      for (const file of files) {
        const safeName = path.basename(file.filename);
        const filepath = path.join(uploadDir, safeName);
        fs.writeFileSync(filepath, file.data);
        savedFiles.push(safeName);
      }
      
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, files: savedFiles }));
    });
    
    return;
  }
  
  // Download file
  if (url.pathname.startsWith('/api/download/') && req.method === 'GET') {
    const filename = decodeURIComponent(url.pathname.replace('/api/download/', ''));
    const filepath = path.join(uploadDir, path.basename(filename));
    
    fs.readFile(filepath, (err, data) => {
      if (err) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'File not found' }));
        return;
      }
      
      res.statusCode = 200;
      res.setHeader('Content-Type', getContentType(filename));
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.end(data);
    });
    return;
  }
  
  // Delete file
  if (url.pathname.startsWith('/api/delete/') && req.method === 'DELETE') {
    const filename = decodeURIComponent(url.pathname.replace('/api/delete/', ''));
    const filepath = path.join(uploadDir, path.basename(filename));
    
    fs.unlink(filepath, (err) => {
      if (err) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'File not found' }));
        return;
      }
      
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
    console.log(`Server running at http://${ip}:${port}`);
  });
});




let gracefulShutdown = function () {
  console.log("Received signal")
    myServer.close(function () {
    console.log("Closing")
      process.exit(0)
    })

   // if after 
   setTimeout(function() {
       console.error("Could not close connections in time, forcefully shutting down")
       process.exit()
  }, 10*1000)
}

process.on('SIGTERM', gracefulShutdown); //For process KILL
process.on('SIGINT', gracefulShutdown) // For Ctrl+C