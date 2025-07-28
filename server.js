import { createServer } from 'node:http';
import dgram from 'node:dgram';


import fs from 'fs';
import path from 'path';

const hostname = '0.0.0.0';
const port = 3000;

// Get static file path from command line argument, default to index.html
const staticFile = process.argv[2] || 'index.html';
const staticFilePath = path.resolve(staticFile);

function getOutboundIP(callback) {
  // UDP trick: connect to a dummy address and get the local address
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


const myServer = createServer((_req, res) => {
  fs.readFile(staticFilePath, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain;charset=UTF-8');
      res.end(`Error: File not found: ${staticFilePath}`);
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html;charset=UTF-8');
    res.setHeader('Server', 'Node');
    res.setHeader('Cache-Control', 'no-transform');
    res.end(data);
  });
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