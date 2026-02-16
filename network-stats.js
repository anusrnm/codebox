import https, { get } from 'https';
import http, { get as _get } from 'http';
import { promises as dns } from 'dns';
import { getServers } from 'dns';
import { createConnection } from 'net';
import { platform, arch, release, hostname as _hostname, type as _type, cpus, totalmem, freemem, uptime, networkInterfaces } from 'os';
import { connect } from 'tls';
import { performance } from 'perf_hooks';

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
};

// Modern UI helpers
function clearLine() {
  if (process.stdout.isTTY) {
    // Move cursor to beginning and clear the entire line
    process.stdout.write('\x1b[0G\x1b[2K');
  }
}

function getLatencyRating(ms) {
  if (ms < 20) return `${colors.green}⚡ Excellent${colors.reset}`;
  if (ms < 50) return `${colors.cyan}🚀 Very Good${colors.reset}`;
  if (ms < 100) return `${colors.yellow}👍 Good${colors.reset}`;
  if (ms < 200) return `${colors.yellow}📶 Fair${colors.reset}`;
  return `${colors.red}🐌 Slow${colors.reset}`;
}

function printSection(title) {
  console.log(`\n  ${colors.bright}${colors.magenta}┌─ ${title} ${'─'.repeat(Math.max(0, 45 - title.length))}┐${colors.reset}`);
}

function printSectionEnd() {
  console.log(`  ${colors.magenta}└${'─'.repeat(49)}┘${colors.reset}`);
}

function printRow(label, value) {
  const paddedLabel = label.padEnd(22);
  console.log(`  ${colors.magenta}│${colors.reset} ${colors.dim}${paddedLabel}${colors.reset} ${value}`);
}

function createProgressBar(percentage, width = 40) {
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return `${colors.cyan}${bar}${colors.reset}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function printHeader(text) {
  console.log(`\n${colors.bright}${colors.cyan}╔${'═'.repeat(text.length + 2)}╗${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}║${colors.reset} ${colors.bright}${text}${colors.reset} ${colors.bright}${colors.cyan}║${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}╚${'═'.repeat(text.length + 2)}╝${colors.reset}`);
}

function printSuccess(label, value) {
  console.log(`${colors.green}✓${colors.reset} ${colors.bright}${label}:${colors.reset} ${colors.cyan}${value}${colors.reset}`);
}

function printInfo(label, value) {
  console.log(`${colors.blue}ℹ${colors.reset} ${colors.dim}${label}:${colors.reset} ${value}`);
}

function printError(message) {
  console.log(`${colors.red}✗${colors.reset} ${colors.red}${message}${colors.reset}`);
}

const spinners = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerIndex = 0;

function getSpinner() {
  spinnerIndex = (spinnerIndex + 1) % spinners.length;
  return `${colors.yellow}${spinners[spinnerIndex]}${colors.reset}`;
}

// Global state for interruption handling
let currentDownloadState = null;

function displayPartialDownloadSummary() {
  if (!currentDownloadState) return;
  
  const state = currentDownloadState;
  const now = performance.now();
  const elapsed = (now - state.startTime) / 1000;
  const speed = ((state.bytesReceived * 8) / elapsed / 1_000_000).toFixed(2);
  
  clearLine();
  console.log(`\n\n${colors.yellow}⚠${colors.reset}  ${colors.bright}Download Interrupted${colors.reset}\n`);
  console.log(`${colors.blue}ℹ${colors.reset} ${colors.dim}Partial Results:${colors.reset}`);
  console.log(`   ${colors.cyan}Downloaded:${colors.reset}       ${formatBytes(state.bytesReceived)}`);
  if (state.totalBytes > 0) {
    const percentage = ((state.bytesReceived / state.totalBytes) * 100).toFixed(1);
    console.log(`   ${colors.cyan}Total Size:${colors.reset}          ${formatBytes(state.totalBytes)} (${percentage}%)`);
  }
  console.log(`   ${colors.cyan}Elapsed Time:${colors.reset}       ${elapsed.toFixed(2)}s`);
  console.log(`   ${colors.cyan}Average Speed:${colors.reset}      ${speed} Mbps`);
  console.log(`   ${colors.cyan}URL:${colors.reset}                ${state.url}\n`);
}

// Network Speed Test in Mbps
async function networkSpeedTest(testUrl, testName = 'Download', timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const startTime = performance.now();
    let bytesReceived = 0;
    let totalBytes = 0;
    let isInterrupted = false;
    const protocol = testUrl.startsWith('https') ? https : http;
    
    // Setup interrupt handler for this download
    const handleInterrupt = () => {
      isInterrupted = true;
      currentDownloadState = { startTime, bytesReceived, totalBytes, url: testUrl };
      request.destroy();
      reject(new Error('INTERRUPTED'));
    };
    
    const sigintHandler = handleInterrupt;
    const sigtermHandler = handleInterrupt;

    printHeader(`${testName} Speed Test`);
    printInfo('URL', testUrl);
    console.log('');

    const request = protocol.get(testUrl, (res) => {
      // Handle redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        printInfo('Redirect', res.headers.location);
        return networkSpeedTest(res.headers.location, testName, timeoutMs)
          .then(resolve)
          .catch(reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
      }

      totalBytes = parseInt(res.headers['content-length']) || 0;
      let lastOutput = '';
      let progressInterval;

      // Rolling speed window for smooth speed display (like npm/Node.js CLIs)
      const SPEED_WINDOW_SIZE = 10; // number of samples to average
      const speedSamples = [];      // { time, bytes } snapshots
      let displayedPercentage = 0;  // for smooth interpolation

      function pushSpeedSample() {
        speedSamples.push({ time: performance.now(), bytes: bytesReceived });
        if (speedSamples.length > SPEED_WINDOW_SIZE) speedSamples.shift();
      }
      // Seed the first sample
      pushSpeedSample();

      function getRollingSpeed() {
        if (speedSamples.length < 2) return 0;
        const oldest = speedSamples[0];
        const newest = speedSamples[speedSamples.length - 1];
        const dt = (newest.time - oldest.time) / 1000; // seconds
        if (dt === 0) return 0;
        return ((newest.bytes - oldest.bytes) * 8) / dt / 1_000_000; // Mbps
      }

      function getETA() {
        if (totalBytes <= 0) return '';
        const speed = getRollingSpeed(); // Mbps
        if (speed <= 0) return 'calculating…';
        const remainingBytes = totalBytes - bytesReceived;
        const remainingBits = remainingBytes * 8;
        const remainingSec = remainingBits / (speed * 1_000_000);
        if (remainingSec < 60) return `${Math.ceil(remainingSec)}s`;
        if (remainingSec < 3600) return `${Math.floor(remainingSec / 60)}m ${Math.ceil(remainingSec % 60)}s`;
        return `${Math.floor(remainingSec / 3600)}h ${Math.floor((remainingSec % 3600) / 60)}m`;
      }

      // Update progress bar
      const updateProgress = () => {
        pushSpeedSample();

        const elapsed = (performance.now() - startTime) / 1000;
        const rollingSpeed = getRollingSpeed().toFixed(2);
        const actualPercentage = totalBytes > 0 ? (bytesReceived / totalBytes) * 100 : 0;

        // Smoothly interpolate displayed percentage toward actual (easing)
        const ease = 0.35;
        displayedPercentage += (actualPercentage - displayedPercentage) * ease;
        // Snap when very close to avoid lingering decimals
        if (Math.abs(actualPercentage - displayedPercentage) < 0.3) {
          displayedPercentage = actualPercentage;
        }
        const percentage = displayedPercentage;

        const eta = getETA();
        const etaStr = eta ? ` | ETA ${colors.yellow}${eta}${colors.reset}` : '';

        let output = '';
        if (process.stdout.isTTY) {
          const termWidth = process.stdout.columns || 80;
          // Reserve space for the text parts to size the bar dynamically
          const sampleText = `X Downloading:  100.0% | 99.99 MB/99.99 MB | 999.99 Mbps | ETA 59m 59s`;
          const availableWidth = Math.max(10, Math.min(30, termWidth - sampleText.length));

          if (totalBytes > 0) {
            const bar = createProgressBar(percentage, availableWidth);
            output = `${getSpinner()} Downloading: ${bar} ${percentage.toFixed(1)}% | ${formatBytes(bytesReceived)}/${formatBytes(totalBytes)} | ${colors.cyan}${rollingSpeed} Mbps${colors.reset}${etaStr}`;
          } else {
            output = `${getSpinner()} Downloading: ${formatBytes(bytesReceived)} | ${colors.cyan}${rollingSpeed} Mbps${colors.reset}`;
          }

          // Truncate fallback
          const outputLength = output.replace(/\x1b\[[0-9;]*m/g, '').length;
          if (outputLength > termWidth - 1) {
            output = `${getSpinner()} Downloading: ${percentage.toFixed(1)}% | ${formatBytes(bytesReceived)} | ${colors.cyan}${rollingSpeed} Mbps${colors.reset}${etaStr}`;
          }
        } else {
          if (totalBytes > 0) {
            const bar = createProgressBar(percentage, 30);
            output = `${getSpinner()} Downloading: ${bar} ${percentage.toFixed(1)}% | ${formatBytes(bytesReceived)}/${formatBytes(totalBytes)} | ${colors.cyan}${rollingSpeed} Mbps${colors.reset}${etaStr}`;
          } else {
            output = `${getSpinner()} Downloading: ${formatBytes(bytesReceived)} | ${colors.cyan}${rollingSpeed} Mbps${colors.reset}`;
          }
        }

        // Only redraw if output changed
        if (output !== lastOutput && process.stdout.isTTY) {
          clearLine();
          process.stdout.write(output);
          lastOutput = output;
        }
      };

      // Render at ~100ms for smooth animation (npm-style throttled rendering)
      progressInterval = setInterval(updateProgress, 100);

      res.on('data', (chunk) => {
        bytesReceived += chunk.length;
      });

      res.on('end', () => {
        clearInterval(progressInterval);
        clearLine();
        process.removeListener('SIGINT', sigintHandler);
        process.removeListener('SIGTERM', sigtermHandler);
        
        const endTime = performance.now();
        const durationMs = endTime - startTime;
        const durationSeconds = durationMs / 1000;
        
        // Calculate speed in Mbps (Megabits per second)
        const bits = bytesReceived * 8;
        const mbps = (bits / durationSeconds / 1_000_000).toFixed(2);
        
        // Also calculate in MB/s for reference
        const mbPerSecond = (bytesReceived / durationSeconds / 1_000_000).toFixed(2);

        console.log(`${colors.green}✓ Download Complete!${colors.reset}\n`);
        printSuccess('Downloaded', formatBytes(bytesReceived));
        printSuccess('Duration', `${durationSeconds.toFixed(2)}s`);
        printSuccess('Average Speed', `${colors.bright}${mbps} Mbps${colors.reset} ${colors.dim}(${mbPerSecond} MB/s)${colors.reset}`);
        
        // Speed rating
        const speed = parseFloat(mbps);
        let rating = '';
        if (speed > 100) rating = `${colors.green}⚡ Excellent${colors.reset}`;
        else if (speed > 50) rating = `${colors.cyan}🚀 Very Good${colors.reset}`;
        else if (speed > 25) rating = `${colors.yellow}👍 Good${colors.reset}`;
        else if (speed > 10) rating = `${colors.yellow}📶 Fair${colors.reset}`;
        else rating = `${colors.red}🐌 Slow${colors.reset}`;
        
        console.log(`${colors.blue}ℹ${colors.reset} ${colors.dim}Rating:${colors.reset} ${rating}`);
        
        resolve({ mbps: parseFloat(mbps), bytes: bytesReceived, duration: durationSeconds });
      });

      res.on('error', (err) => {
        clearInterval(progressInterval);
        process.removeListener('SIGINT', sigintHandler);
        process.removeListener('SIGTERM', sigtermHandler);
        reject(err);
      });
    });

    request.on('error', (err) => {
      clearInterval(progressInterval ?? 0);
      process.removeListener('SIGINT', sigintHandler);
      process.removeListener('SIGTERM', sigtermHandler);
      if (err.code === 'ERR_HTTP_REQUEST_TIMEOUT') {
        reject(new Error(`Request timeout after ${timeoutMs / 1000}s`));
      } else {
        reject(new Error(`Network error: ${err.message}`));
      }
    });
    
    // Register interrupt handlers for this download
    process.on('SIGINT', sigintHandler);
    process.on('SIGTERM', sigtermHandler);
    
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      process.removeListener('SIGINT', sigintHandler);
      process.removeListener('SIGTERM', sigtermHandler);
      reject(new Error(`Request timeout after ${timeoutMs / 1000}s`));
    });
  });
}

async function comprehensiveNetworkTest(url) {
  const urlObj = new URL(url);
  const hostname = urlObj.hostname;
  const port = urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80);
  const isHttps = urlObj.protocol === 'https:';

  printHeader('Comprehensive Network Diagnostics');
  printInfo('Target', url);
  printInfo('Timestamp', new Date().toISOString());
  printInfo('Platform', `${platform()} ${arch()} (${release()})`);

  // ── 1. Local System Info ──
  printSection('Local System Info');
  printRow('Hostname', `${colors.cyan}${_hostname()}${colors.reset}`);
  printRow('OS', `${colors.cyan}${_type()} ${release()}${colors.reset}`);
  printRow('Architecture', `${colors.cyan}${arch()}${colors.reset}`);
  printRow('CPUs', `${colors.cyan}${cpus().length} cores${colors.reset}`);
  printRow('Total Memory', `${colors.cyan}${(totalmem() / (1024 ** 3)).toFixed(2)} GB${colors.reset}`);
  printRow('Free Memory', `${colors.cyan}${(freemem() / (1024 ** 3)).toFixed(2)} GB${colors.reset}`);
  printRow('Uptime', `${colors.cyan}${(uptime() / 3600).toFixed(1)} hours${colors.reset}`);
  printRow('Node.js Version', `${colors.cyan}${process.version}${colors.reset}`);
  printSectionEnd();

  // ── 2. Network Interfaces ──
  printSection('Network Interfaces');
  const interfaces = networkInterfaces();
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (addr.internal) continue;
      const type = addr.family === 'IPv4' ? `${colors.green}IPv4${colors.reset}` : `${colors.blue}IPv6${colors.reset}`;
      printRow(name, `${type} ${colors.cyan}${addr.address}${colors.reset} ${colors.dim}(MAC: ${addr.mac})${colors.reset}`);
      if (addr.family === 'IPv4') {
        printRow('  Netmask', `${colors.cyan}${addr.netmask}${colors.reset}`);
        printRow('  CIDR', `${colors.cyan}${addr.cidr}${colors.reset}`);
      }
    }
  }
  printSectionEnd();

  // ── 3. Default Gateway / DNS Servers ──
  printSection('System DNS Configuration');
  try {
    const resolvers = getServers();
    resolvers.forEach((server, i) => {
      printRow(`DNS Server ${i + 1}`, `${colors.cyan}${server}${colors.reset}`);
    });
  } catch (e) {
    printRow('DNS Servers', `${colors.dim}Unable to retrieve${colors.reset}`);
  }
  printSectionEnd();

  // ── 4. Public IP Address ──
  printSection('Public IP Address');
  process.stdout.write(`  ${colors.magenta}│${colors.reset} ${getSpinner()} Fetching public IP...`);
  try {
    const publicIp = await new Promise((resolve, reject) => {
      get('https://api.ipify.org?format=json', (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }).on('error', reject).setTimeout(5000, () => reject(new Error('Timeout')));
    });
    clearLine();
    printRow('Public IPv4', `${colors.cyan}${publicIp.ip}${colors.reset}`);
  } catch (e) {
    clearLine();
    printRow('Public IPv4', `${colors.red}Could not determine${colors.reset}`);
  }

  try {
    const publicIp6 = await new Promise((resolve, reject) => {
      get('https://api64.ipify.org?format=json', (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }).on('error', reject).setTimeout(5000, () => reject(new Error('Timeout')));
    });
    printRow('Public IPv6', `${colors.cyan}${publicIp6.ip}${colors.reset}`);
  } catch (e) {
    printRow('Public IPv6', `${colors.dim}Not available${colors.reset}`);
  }

  // Geo-IP lookup
  try {
    const geoData = await new Promise((resolve, reject) => {
      _get('http://ip-api.com/json/?fields=status,country,regionName,city,isp,org,as,query', (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }).on('error', reject).setTimeout(5000, () => reject(new Error('Timeout')));
    });
    if (geoData.status === 'success') {
      printRow('Location', `${colors.cyan}${geoData.city}, ${geoData.regionName}, ${geoData.country}${colors.reset}`);
      printRow('ISP', `${colors.cyan}${geoData.isp}${colors.reset}`);
      printRow('Organization', `${colors.cyan}${geoData.org}${colors.reset}`);
      printRow('AS Number', `${colors.cyan}${geoData.as}${colors.reset}`);
    }
  } catch (e) {
    printRow('Geo Location', `${colors.dim}Could not determine${colors.reset}`);
  }
  printSectionEnd();

  // ── 5. DNS Resolution (all record types) ──
  printSection('DNS Resolution');
  process.stdout.write(`  ${colors.magenta}│${colors.reset} ${getSpinner()} Resolving DNS...`);
  const dnsStart = performance.now();
  
  // A records
  let ipv4Addrs = [];
  try {
    ipv4Addrs = await dns.resolve4(hostname);
    const dnsTime = parseFloat((performance.now() - dnsStart).toFixed(2));
    clearLine();
    printRow('A Records (IPv4)', `${colors.cyan}${ipv4Addrs.join(', ')}${colors.reset}`);
    printRow('DNS Lookup Time', `${colors.cyan}${dnsTime}ms${colors.reset} ${getLatencyRating(dnsTime)}`);
  } catch (e) {
    clearLine();
    printRow('A Records (IPv4)', `${colors.dim}None${colors.reset}`);
  }

  // AAAA records  
  try {
    const ipv6Addrs = await dns.resolve6(hostname);
    printRow('AAAA Records (IPv6)', `${colors.cyan}${ipv6Addrs.join(', ')}${colors.reset}`);
  } catch (e) {
    printRow('AAAA Records (IPv6)', `${colors.dim}None${colors.reset}`);
  }

  // CNAME
  try {
    const cnames = await dns.resolveCname(hostname);
    printRow('CNAME Records', `${colors.cyan}${cnames.join(', ')}${colors.reset}`);
  } catch (e) {
    printRow('CNAME Records', `${colors.dim}None${colors.reset}`);
  }

  // MX records
  try {
    const mxRecords = await dns.resolveMx(hostname);
    mxRecords.sort((a, b) => a.priority - b.priority);
    mxRecords.forEach((mx) => {
      printRow('MX Record', `${colors.cyan}${mx.exchange}${colors.reset} ${colors.dim}(priority: ${mx.priority})${colors.reset}`);
    });
  } catch (e) {
    printRow('MX Records', `${colors.dim}None${colors.reset}`);
  }

  // NS records
  try {
    const nsRecords = await dns.resolveNs(hostname);
    printRow('NS Records', `${colors.cyan}${nsRecords.join(', ')}${colors.reset}`);
  } catch (e) {
    printRow('NS Records', `${colors.dim}None${colors.reset}`);
  }

  // TXT records
  try {
    const txtRecords = await dns.resolveTxt(hostname);
    txtRecords.forEach((txt, i) => {
      const val = txt.join('');
      if (val.length > 60) {
        printRow(`TXT Record ${i + 1}`, `${colors.dim}${val.substring(0, 60)}...${colors.reset}`);
      } else {
        printRow(`TXT Record ${i + 1}`, `${colors.dim}${val}${colors.reset}`);
      }
    });
  } catch (e) {
    // TXT records are optional
  }

  // SOA
  try {
    const soa = await dns.resolveSoa(hostname);
    printRow('SOA Primary NS', `${colors.cyan}${soa.nsname}${colors.reset}`);
    printRow('SOA Contact', `${colors.cyan}${soa.hostmaster}${colors.reset}`);
    printRow('SOA Serial', `${colors.cyan}${soa.serial}${colors.reset}`);
  } catch (e) {
    // SOA is optional
  }

  // Reverse DNS
  if (ipv4Addrs.length > 0) {
    try {
      const reverseNames = await dns.reverse(ipv4Addrs[0]);
      printRow('Reverse DNS (PTR)', `${colors.cyan}${reverseNames.join(', ')}${colors.reset}`);
    } catch (e) {
      printRow('Reverse DNS (PTR)', `${colors.dim}None${colors.reset}`);
    }
  }
  printSectionEnd();

  // ── 6. TCP Connection ──
  printSection('TCP Connection');
  const tcpResult = await new Promise((resolve) => {
    process.stdout.write(`  ${colors.magenta}│${colors.reset} ${getSpinner()} Connecting TCP...`);
    const tcpStart = performance.now();
    const socket = createConnection(port, hostname);
    socket.on('connect', () => {
      const tcpTime = parseFloat((performance.now() - tcpStart).toFixed(2));
      clearLine();
      printRow('TCP Handshake', `${colors.cyan}${tcpTime}ms${colors.reset} ${getLatencyRating(tcpTime)}`);
      printRow('Remote Address', `${colors.cyan}${socket.remoteAddress}${colors.reset}`);
      printRow('Remote Port', `${colors.cyan}${socket.remotePort}${colors.reset}`);
      printRow('Remote Family', `${colors.cyan}${socket.remoteFamily}${colors.reset}`);
      printRow('Local Address', `${colors.cyan}${socket.localAddress}${colors.reset}`);
      printRow('Local Port', `${colors.cyan}${socket.localPort}${colors.reset}`);
      socket.end();
      resolve({ success: true, time: tcpTime });
    });
    socket.on('error', (err) => {
      clearLine();
      printRow('TCP Connection', `${colors.red}Failed: ${err.message}${colors.reset}`);
      resolve({ success: false });
    });
    socket.setTimeout(10000, () => {
      socket.destroy();
      clearLine();
      printRow('TCP Connection', `${colors.red}Timeout${colors.reset}`);
      resolve({ success: false });
    });
  });
  printSectionEnd();

  // ── 7. TLS/SSL Certificate ──
  if (isHttps) {
    printSection('TLS/SSL Certificate');
    process.stdout.write(`  ${colors.magenta}│${colors.reset} ${getSpinner()} Checking TLS...`);
    try {
      const tlsResult = await new Promise((resolve, reject) => {
        const tlsStart = performance.now();
        const socket = connect({ host: hostname, port, servername: hostname }, () => {
          const tlsTime = (performance.now() - tlsStart).toFixed(2);
          const cert = socket.getPeerCertificate();
          const protocol = socket.getProtocol();
          const cipher = socket.getCipher();
          socket.end();
          resolve({ cert, protocol, cipher, tlsTime });
        });
        socket.on('error', reject);
        socket.setTimeout(10000, () => { socket.destroy(); reject(new Error('Timeout')); });
      });
      clearLine();
      printRow('TLS Handshake', `${colors.cyan}${tlsResult.tlsTime}ms${colors.reset}`);
      printRow('TLS Protocol', `${colors.cyan}${tlsResult.protocol}${colors.reset}`);
      printRow('Cipher Suite', `${colors.cyan}${tlsResult.cipher.name}${colors.reset}`);
      printRow('Cipher Version', `${colors.cyan}${tlsResult.cipher.version}${colors.reset}`);
      
      const cert = tlsResult.cert;
      if (cert && cert.subject) {
        printRow('Subject CN', `${colors.cyan}${cert.subject.CN || 'N/A'}${colors.reset}`);
        printRow('Issuer', `${colors.cyan}${cert.issuer.O || cert.issuer.CN || 'N/A'}${colors.reset}`);
        printRow('Valid From', `${colors.cyan}${cert.valid_from}${colors.reset}`);
        printRow('Valid To', `${colors.cyan}${cert.valid_to}${colors.reset}`);
        
        // Check expiry
        const expiryDate = new Date(cert.valid_to);
        const daysUntilExpiry = Math.floor((expiryDate - Date.now()) / (1000 * 60 * 60 * 24));
        const expiryColor = daysUntilExpiry > 30 ? colors.green : daysUntilExpiry > 7 ? colors.yellow : colors.red;
        printRow('Days Until Expiry', `${expiryColor}${daysUntilExpiry} days${colors.reset}`);
        
        if (cert.subjectaltname) {
          const sans = cert.subjectaltname.split(', ').slice(0, 5);
          printRow('SANs', `${colors.cyan}${sans.join(', ')}${sans.length < cert.subjectaltname.split(', ').length ? '...' : ''}${colors.reset}`);
        }
        printRow('Serial Number', `${colors.dim}${cert.serialNumber}${colors.reset}`);
        printRow('Fingerprint (SHA256)', `${colors.dim}${cert.fingerprint256 || cert.fingerprint}${colors.reset}`);
      }
    } catch (e) {
      clearLine();
      printRow('TLS/SSL', `${colors.red}Failed: ${e.message}${colors.reset}`);
    }
    printSectionEnd();
  }

  // ── 8. HTTP Response Details ──
  printSection('HTTP Response Details');
  process.stdout.write(`  ${colors.magenta}│${colors.reset} ${getSpinner()} Sending HTTP request...`);
  
  await new Promise((resolve) => {
    const proto = isHttps ? https : http;
    const httpStart = performance.now();
    const req = proto.get(url, { headers: { 'User-Agent': 'NetworkStats/1.0' } }, (res) => {
      const ttfb = parseFloat((performance.now() - httpStart).toFixed(2));
      clearLine();
      printRow('HTTP Status', `${colors.cyan}${res.statusCode} ${res.statusMessage}${colors.reset}`);
      printRow('HTTP Version', `${colors.cyan}${res.httpVersion}${colors.reset}`);
      printRow('TTFB', `${colors.cyan}${ttfb}ms${colors.reset} ${getLatencyRating(ttfb)}`);
      
      // Important headers
      const importantHeaders = [
        'server', 'content-type', 'content-length', 'content-encoding',
        'cache-control', 'x-powered-by', 'x-frame-options', 'x-content-type-options',
        'strict-transport-security', 'content-security-policy', 'x-xss-protection',
        'access-control-allow-origin', 'vary', 'connection', 'keep-alive',
        'transfer-encoding', 'alt-svc', 'via',
      ];
      
      console.log(`  ${colors.magenta}│${colors.reset}`);
      console.log(`  ${colors.magenta}│${colors.reset}   ${colors.bright}Response Headers:${colors.reset}`);
      
      for (const header of importantHeaders) {
        if (res.headers[header]) {
          const val = res.headers[header];
          const display = typeof val === 'string' && val.length > 55 ? val.substring(0, 55) + '...' : val;
          printRow(`  ${header}`, `${colors.cyan}${display}${colors.reset}`);
        }
      }

      // Security headers check
      console.log(`  ${colors.magenta}│${colors.reset}`);
      console.log(`  ${colors.magenta}│${colors.reset}   ${colors.bright}Security Headers:${colors.reset}`);
      const securityHeaders = {
        'strict-transport-security': 'HSTS',
        'content-security-policy': 'CSP',
        'x-frame-options': 'X-Frame-Options',
        'x-content-type-options': 'X-Content-Type-Options',
        'x-xss-protection': 'X-XSS-Protection',
        'referrer-policy': 'Referrer-Policy',
        'permissions-policy': 'Permissions-Policy',
      };
      for (const [header, label] of Object.entries(securityHeaders)) {
        const present = !!res.headers[header];
        printRow(`  ${label}`, present ? `${colors.green}✓ Present${colors.reset}` : `${colors.red}✗ Missing${colors.reset}`);
      }

      let bytes = 0;
      res.on('data', (chunk) => bytes += chunk.length);
      res.on('end', () => {
        const total = performance.now() - httpStart;
        console.log(`  ${colors.magenta}│${colors.reset}`);
        printRow('Total Request Time', `${colors.cyan}${total.toFixed(2)}ms${colors.reset}`);
        printRow('Content Downloaded', `${colors.cyan}${formatBytes(bytes)}${colors.reset}`);
        printSectionEnd();
        resolve();
      });
    });
    req.on('error', (err) => {
      clearLine();
      printRow('HTTP Request', `${colors.red}Failed: ${err.message}${colors.reset}`);
      printSectionEnd();
      resolve();
    });
    req.setTimeout(15000, () => { req.destroy(); resolve(); });
  });

  // ── 9. Ping / Latency (multiple samples) ──
  printSection('Latency Test (5 samples)');
  const latencies = [];
  for (let i = 0; i < 5; i++) {
    process.stdout.write(`  ${colors.magenta}│${colors.reset} ${getSpinner()} Ping ${i + 1}/5...`);
    const latency = await new Promise((resolve) => {
      const start = performance.now();
      const socket = createConnection(port, hostname);
      socket.on('connect', () => {
        const time = performance.now() - start;
        socket.end();
        resolve(time);
      });
      socket.on('error', () => resolve(-1));
      socket.setTimeout(5000, () => { socket.destroy(); resolve(-1); });
    });
    clearLine();

    if (latency >= 0) {
      latencies.push(latency);
      printRow(`Ping ${i + 1}`, `${colors.cyan}${latency.toFixed(2)}ms${colors.reset}`);
    } else {
      printRow(`Ping ${i + 1}`, `${colors.red}Timeout${colors.reset}`);
    }
  }

  if (latencies.length > 0) {
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const min = Math.min(...latencies);
    const max = Math.max(...latencies);
    
    // Calculate jitter (average of differences between consecutive samples)
    let jitter = 0;
    if (latencies.length > 1) {
      for (let i = 1; i < latencies.length; i++) {
        jitter += Math.abs(latencies[i] - latencies[i - 1]);
      }
      jitter /= (latencies.length - 1);
    }
    
    // Standard deviation
    const variance = latencies.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / latencies.length;
    const stddev = Math.sqrt(variance);
    
    // Packet loss
    const loss = ((5 - latencies.length) / 5 * 100).toFixed(1);

    console.log(`  ${colors.magenta}│${colors.reset}`);
    printRow('Min Latency', `${colors.cyan}${min.toFixed(2)}ms${colors.reset}`);
    printRow('Max Latency', `${colors.cyan}${max.toFixed(2)}ms${colors.reset}`);
    printRow('Avg Latency', `${colors.cyan}${avg.toFixed(2)}ms${colors.reset} ${getLatencyRating(avg)}`);
    printRow('Jitter', `${colors.cyan}${jitter.toFixed(2)}ms${colors.reset}`);
    printRow('Std Deviation', `${colors.cyan}${stddev.toFixed(2)}ms${colors.reset}`);
    printRow('Packet Loss', `${loss > 0 ? colors.red : colors.green}${loss}%${colors.reset}`);
  }
  printSectionEnd();
}

// Run comprehensive test first
(async () => {
  try {
    await comprehensiveNetworkTest('https://www.google.com');
    
    // Wait a bit then run speed test with a larger file
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Try multiple test file sources from trusted providers
    const testUrls = [
      // Google Cloud Storage - publicly accessible test files
      { url: 'https://storage.googleapis.com/gcp-public-data-landsat/LC08/01/001/002/LC08_L1GT_001002_20160817_20170322_01_T2/LC08_L1GT_001002_20160817_20170322_01_T2_B1.TIF', name: 'Google Cloud Storage' },
      
      // Cloudflare speed test
      { url: 'https://speed.cloudflare.com/__down?bytes=5000000', name: 'Cloudflare CDN (5MB)' },
      
      // GitHub releases (reliable alternative)
      { url: 'https://github.com/git-for-windows/git/releases/download/v2.43.0.windows.1/Git-2.43.0-64-bit.exe', name: 'GitHub CDN' },
    ];

    let success = false;
    
    for (const test of testUrls) {
      try {
        console.log('');
        printInfo('Attempting', test.name);
        await networkSpeedTest(test.url, test.name, 60000);
        success = true;
        break; // Stop after first successful test
      } catch (error) {
        // Re-throw interruption errors immediately without trying next URL
        if (error.message === 'INTERRUPTED') {
          throw error;
        }
        printError(`${test.name} failed: ${error.message}`);
        if (testUrls.indexOf(test) < testUrls.length - 1) {
          printInfo('Status', 'Trying next test URL...');
        }
      }
    }
    
    if (!success) {
      console.log('');
      printHeader('All Speed Tests Failed');
      console.log(`${colors.yellow}⚠${colors.reset}  ${colors.dim}Possible causes:${colors.reset}`);
      console.log(`   ${colors.dim}• Firewall blocking connections${colors.reset}`);
      console.log(`   ${colors.dim}• Proxy settings needed${colors.reset}`);
      console.log(`   ${colors.dim}• Network connectivity issues${colors.reset}`);
    }
  } catch (error) {
    // Check if this was an interruption
    if (error.message === 'INTERRUPTED') {
      displayPartialDownloadSummary();
      process.exit(130); // Standard exit code for SIGINT
    } else {
      printError(`Test failed: ${error.message}`);
    }
  }
})();
