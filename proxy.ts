/**
 * Instalar dependencias:
 *   npm install node-forge @types/node-forge
 *   npm install -D typescript ts-node @types/node
 *
 * Ejecutar (como administrador):
 *   npx ts-node proxy.ts
 *
 * O compilar y ejecutar:
 *   npx tsc proxy.ts --target ES2020 --module commonjs --esModuleInterop
 *   node proxy.js
 *
 * Requiere: Node.js 18+, Windows, permisos de administrador.
 */

import * as net        from 'net';
import * as tls        from 'tls';
import * as dgram      from 'dgram';
import * as fs         from 'fs';
import * as path       from 'path';
import * as readline   from 'readline';
import { execSync, spawnSync, execFileSync } from 'child_process';
import * as forge      from 'node-forge';

// ════════════════════════════════════════════════════════════════════════════
//  ESTADO GLOBAL
// ════════════════════════════════════════════════════════════════════════════

let interceptEnabled   = false;
let interceptPath      = '';
let jsonFilePath       = '';
let interceptedCount   = 0;
let totalCount         = 0;

let caCert: forge.pki.Certificate;
let caKey:  forge.pki.rsa.PrivateKey;

// Caché de contextos TLS por hostname (evita regenerar certs en cada conexión)
const leafCertCache = new Map<string, tls.SecureContext>();

// Adaptador de red activo (guardado para restaurar DNS al salir)
let activeAdapter = 'Ethernet';

// Timer para rebind del menú (evita redraws múltiples consecutivos)
let redrawTimer: ReturnType<typeof setTimeout> | null = null;

// ════════════════════════════════════════════════════════════════════════════
//  CONSTANTES
// ════════════════════════════════════════════════════════════════════════════

const CA_CERT_FILE  = 'proxy-ca.crt';
const CA_KEY_FILE   = 'proxy-ca.key';
const CA_COMMON_NAME = 'FortniteProxy CA';
const UPSTREAM_DNS  = '8.8.8.8';
const UPSTREAM_DNS6 = '2001:4860:4860::8888';

// ANSI helpers
const ESC    = '\x1b';
const CLEAR  = `${ESC}[2J${ESC}[H`;
const RED    = `${ESC}[31m`;
const GREEN  = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const CYAN   = `${ESC}[36m`;
const BOLD   = `${ESC}[1m`;
const RESET  = `${ESC}[0m`;

// ════════════════════════════════════════════════════════════════════════════
//  LOGGER
// ════════════════════════════════════════════════════════════════════════════

function log(msg: string): void {
  const ts = new Date().toTimeString().slice(0, 8);
  process.stdout.write(`${ESC}[90m[${ts}]${RESET} ${msg}\n`);
}

// ════════════════════════════════════════════════════════════════════════════
//  COMPROBACIÓN Y RELANZO COMO ADMINISTRADOR
// ════════════════════════════════════════════════════════════════════════════

function isAdmin(): boolean {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "[bool](([System.Security.Principal.WindowsIdentity]::GetCurrent()).groups -match \'S-1-5-32-544\')"',
      { encoding: 'utf8', stdio: 'pipe' }
    );
    return out.trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
}
function relaunchAsAdmin(): void {
  const cwd    = process.cwd();
  const tsNode = path.join(cwd, 'node_modules', '.bin', 'ts-node.cmd');
  const script = path.resolve(process.argv[1]);

  // Crear .bat temporal para ejecutar ts-node con elevación
  // (pause al final para que la ventana no se cierre si hay error)
  const bat = path.join(cwd, '_proxy_admin.bat');
  fs.writeFileSync(bat,
    `@echo off\r\ncd /d "${cwd}"\r\n"${tsNode}" "${script}"\r\npause\r\n`
  );

  spawnSync('powershell', [
    '-NoProfile', '-Command',
    `Start-Process "${bat}" -Verb RunAs`
  ], { stdio: 'inherit' });

  // Limpiar bat después de un momento
  setTimeout(() => { try { fs.unlinkSync(bat); } catch {} }, 3000);
}
// ════════════════════════════════════════════════════════════════════════════
//  CONSOLA / ANSI
// ════════════════════════════════════════════════════════════════════════════

function enableANSI(): void {
  // Node en Windows con conhost ya soporta ANSI desde v18.
  // Intentamos activarlo explícitamente si es posible.
  try {
    execSync(
      'reg add HKCU\\Console /v VirtualTerminalLevel /t REG_DWORD /d 1 /f',
      { stdio: 'pipe' }
    );
  } catch { /* ignorar si falla */ }
}

function setConsoleTitle(title: string): void {
  process.stdout.write(`\x1b]0;${title}\x07`);
  process.title = title;
}

function updateTitle(): void {
  const status = interceptEnabled ? 'ON' : 'OFF';
  setConsoleTitle(`Glow Proxy INTERCEPT: [${status}]`);
}

function print(s: string): void { process.stdout.write(s); }
function println(s = ''): void  { process.stdout.write(s + '\n'); }

async function waitEnter(): Promise<void> {
  print('\n  Press Enter to exit...');
  return new Promise(res => {
    process.stdin.resume();
    process.stdin.once('data', () => res());
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  SELECCIÓN DE FICHERO JSON (PowerShell OpenFileDialog)
// ════════════════════════════════════════════════════════════════════════════

function pickJSONFile(): string {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    "$d.Filter = 'JSON files (*.json)|*.json|All files (*.*)|*.*'",
    "$d.Title  = 'Select world/info JSON file'",
    '$d.InitialDirectory = [Environment]::GetFolderPath("Desktop")',
    "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.FileName }",
  ].join('; ');

  try {
    const out = execSync(`powershell -NoProfile -Command "${script}"`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim();
  } catch {
    return '';
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  GESTIÓN DE CERTIFICADO CA (generación / carga / instalación)
// ════════════════════════════════════════════════════════════════════════════

function loadOrGenCA(): void {
  // Intentar cargar CA existente del disco
  if (fs.existsSync(CA_CERT_FILE) && fs.existsSync(CA_KEY_FILE)) {
    try {
      caCert = forge.pki.certificateFromPem(fs.readFileSync(CA_CERT_FILE, 'utf8'));
      caKey  = forge.pki.privateKeyFromPem(fs.readFileSync(CA_KEY_FILE, 'utf8')) as forge.pki.rsa.PrivateKey;
      log(`CA cargada desde disco: ${CA_CERT_FILE}`);
      return;
    } catch (e: any) {
      throw new Error(`bad cert PEM: ${e.message}`);
    }
  }

  // Generar nueva CA RSA-2048
  log('Generando nuevo par de claves CA (RSA-2048)…');
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();

  cert.publicKey    = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));

  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 60 * 60 * 1000);  // -1h
  cert.validity.notAfter  = new Date(now.getTime() + 10 * 365.25 * 24 * 60 * 60 * 1000); // +10 años

  const attrs = [
    { name: 'commonName',        value: CA_COMMON_NAME },
    { name: 'organizationName',  value: 'FortniteProxy' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  caCert = cert;
  caKey  = keys.privateKey;

  fs.writeFileSync(CA_CERT_FILE, forge.pki.certificateToPem(cert),        { mode: 0o644 });
  fs.writeFileSync(CA_KEY_FILE,  forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
  log(`CA guardada: ${CA_CERT_FILE} / ${CA_KEY_FILE}`);
}

function isCACertInstalled(): boolean {
  try {
    const out = execSync(`certutil -verifystore root "${CA_COMMON_NAME}"`, {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return out.includes(CA_COMMON_NAME);
  } catch {
    return false;
  }
}

function installCACert(): void {
  const res = spawnSync('certutil', ['-addstore', '-f', 'root', CA_CERT_FILE], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (res.status !== 0) {
    throw new Error(`certutil failed: ${(res.stderr ?? res.stdout ?? '').trim()}`);
  }
}

// ── Generación de certificado de hoja por hostname ──────────────────────────

function genLeafContext(host: string): tls.SecureContext {
  if (leafCertCache.has(host)) return leafCertCache.get(host)!;

  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();

  cert.publicKey    = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));

  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 60 * 1000);
  cert.validity.notAfter  = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  cert.setSubject([{ name: 'commonName', value: host }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'subjectAltName', altNames: [{ type: 2 /* dNSName */, value: host }] },
    { name: 'keyUsage', digitalSignature: true },
    { name: 'extKeyUsage', serverAuth: true },
  ]);

  cert.sign(caKey, forge.md.sha256.create());

  const ctx = tls.createSecureContext({
    cert: forge.pki.certificateToPem(cert),
    key:  forge.pki.privateKeyToPem(keys.privateKey),
  });
  leafCertCache.set(host, ctx);
  return ctx;
}

// ════════════════════════════════════════════════════════════════════════════
//  SERVIDOR DNS UDP  (0.0.0.0:53 y [::]:53  →  8.8.8.8:53)
// ════════════════════════════════════════════════════════════════════════════

/** Extrae el primer nombre de consulta de un mensaje DNS crudo. */
function parseDNSName(buf: Buffer, start: number): { name: string; end: number } {
  const labels: string[] = [];
  let i = start;
  let jumped = false;
  let end = start;

  while (i < buf.length) {
    const len = buf[i];
    if (len === 0) {
      if (!jumped) end = i + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) end = i + 2;
      i = ((len & 0x3f) << 8) | buf[i + 1];
      jumped = true;
      continue;
    }
    i++;
    labels.push(buf.subarray(i, i + len).toString('ascii'));
    i += len;
    if (!jumped) end = i;
  }
  return { name: labels.join('.'), end };
}

function parseDNSQuestion(msg: Buffer): { name: string; qtype: number } | null {
  if (msg.length < 12) return null;
  try {
    const { name, end } = parseDNSName(msg, 12);
    if (end + 2 > msg.length) return null;
    const qtype = msg.readUInt16BE(end);
    return { name, qtype };
  } catch {
    return null;
  }
}

function createDNSSocket(type: 'udp4' | 'udp6', bindAddr: string): void {
  const sock = dgram.createSocket(type);

  sock.on('error', (err) => {
    log(`DNS ${type} error: ${err.message}`);
  });

  sock.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    const q = parseDNSQuestion(msg);
    if (q) log(`DNS forward ${q.name} (type=${q.qtype})`);

    // Reenviar al upstream y devolver respuesta al cliente
    const upstream = dgram.createSocket(type);
    const upstreamHost = type === 'udp4' ? UPSTREAM_DNS : UPSTREAM_DNS6;

    upstream.on('error', () => upstream.close());

    upstream.send(msg, 53, upstreamHost, (err) => {
      if (err) { upstream.close(); return; }

      upstream.once('message', (reply: Buffer) => {
        sock.send(reply, rinfo.port, rinfo.address, () => {});
        upstream.close();
      });

      // Timeout para respuestas upstream
      setTimeout(() => upstream.close(), 5000);
    });
  });

  sock.bind(53, bindAddr, () => {
    log(`DNS server listening on ${bindAddr}:53`);
  });
}

function startDNSServer(): void {
  createDNSSocket('udp4', '0.0.0.0');
  try {
    createDNSSocket('udp6', '::');
  } catch (e: any) {
    log(`DNS IPv6 listener skipped: ${e.message}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  DNS DE WINDOWS (netsh)
// ════════════════════════════════════════════════════════════════════════════

function getActiveAdapter(): string {
  try {
    const out = execSync('netsh interface show interface', {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    for (const line of out.split('\n')) {
      // Buscar línea con estado "Conectado" / "Connected"
      if (/connected|conectado/i.test(line)) {
        // Formato: "Enabled  Connected  Dedicated  Ethernet"
        const parts = line.trim().split(/\s{2,}/);
        if (parts.length >= 4) return parts[parts.length - 1].trim();
      }
    }
  } catch { /* fallback */ }
  return 'Ethernet';
}

function setWindowsDNS(): void {
  activeAdapter = getActiveAdapter();
  execSync(
    `netsh interface ip set dns "${activeAdapter}" static 127.0.0.1`,
    { stdio: 'pipe' }
  );
}

function restoreWindowsDNS(): void {
  try {
    execSync(
      `netsh interface ip set dns "${activeAdapter}" dhcp`,
      { stdio: 'pipe' }
    );
    execSync('ipconfig /flushdns', { stdio: 'pipe' });
    log('Windows DNS restaurado a DHCP');
  } catch (e: any) {
    log(`restoreWindowsDNS: ${e.message}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  PROXY TLS MITM  (:443)
// ════════════════════════════════════════════════════════════════════════════

/** Aplica los parches JSON del archivo de configuración al cuerpo de la petición. */
function applyJSONConfig(body: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> {
  if (!jsonFilePath) return body;
  try {
    const patches = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8')) as Record<string, unknown>;
    const obj     = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    Object.assign(obj, patches);
    return Buffer.from(JSON.stringify(obj));
  } catch (e: any) {
    log(`error decoding message: ${e.message}`);
    return body;
  }
}

/**
 * Maneja una conexión TLS entrante:
 *   1. Termina TLS con el cliente (usando certificado firmado por nuestra CA).
 *   2. Establece TLS con el servidor real.
 *   3. Si el intercept está activo y la ruta coincide, modifica el body.
 *   4. Si no, hace pipe transparente.
 */
function handleConnection(clientSock: tls.TLSSocket): void {
  const host = clientSock.servername || 'localhost';
  totalCount++;
  scheduleRedraw();

  const serverSock = tls.connect({
    host,
    port: 443,
    servername: host,
    rejectUnauthorized: false,
  });

  serverSock.on('error', (err: Error) => {
    log(`FORWARD   error: ${err.message}`);
    clientSock.destroy();
  });

  clientSock.on('error', () => serverSock.destroy());

  serverSock.once('secureConnect', () => {
    // Sin intercept activo → pipe bidireccional transparente
    if (!interceptEnabled || !interceptPath) {
      log(`PASS (transparent) → ${host}`);
      clientSock.pipe(serverSock);
      serverSock.pipe(clientSock);
      clientSock.on('close', () => serverSock.destroy());
      serverSock.on('close', () => clientSock.destroy());
      return;
    }

    // Con intercept activo: leer la primera petición HTTP completa
    let reqBuf = Buffer.alloc(0);
    let headersDone = false;
    let contentLength = 0;
    let headerEnd = -1;
    let requestLine = '';

    clientSock.on('data', (chunk: Buffer) => {
      reqBuf = Buffer.concat([reqBuf, chunk]);

      if (!headersDone) {
        headerEnd = reqBuf.indexOf('\r\n\r\n');
        if (headerEnd === -1) return; // esperar más datos

        headersDone = true;
        const headerStr = reqBuf.subarray(0, headerEnd).toString('utf8');
        requestLine = headerStr.split('\r\n')[0] ?? '';

        // Extraer Content-Length del header
        const clMatch = headerStr.match(/content-length:\s*(\d+)/i);
        contentLength = clMatch ? parseInt(clMatch[1], 10) : 0;
      }

      // ¿Ya tenemos el body completo?
      const bodyStart  = headerEnd + 4;
      const bodyReceived = reqBuf.length - bodyStart;
      if (bodyReceived < contentLength) return; // esperar más

      // Body completo — desactivar listener y procesar
      clientSock.removeAllListeners('data');

      const urlPath = (requestLine.split(' ')[1] ?? '');
      const headers = reqBuf.subarray(0, headerEnd).toString('utf8');
      let   body: Buffer<ArrayBufferLike> = reqBuf.subarray(bodyStart, bodyStart + contentLength);

      if (urlPath.includes(interceptPath)) {
        interceptedCount++;
        scheduleRedraw();
        log(`INTERCEPT ${urlPath}`);

        body = applyJSONConfig(body);

        // Reconstruir petición con body parchado y Content-Length actualizado
        const newHeaders = headers.replace(
          /content-length:\s*\d+/i,
          `Content-Length: ${body.length}`
        );
        serverSock.write(Buffer.concat([
          Buffer.from(newHeaders + '\r\n\r\n'),
          body,
        ]));
      } else {
        log(`PASS ${urlPath} (transparent)`);
        serverSock.write(reqBuf.subarray(0, bodyStart + contentLength));
      }

      // Resto de la sesión → pipe transparente
      clientSock.pipe(serverSock);
      serverSock.pipe(clientSock);
      clientSock.on('close', () => serverSock.destroy());
      serverSock.on('close', () => clientSock.destroy());
    });

    // Respuestas del servidor siempre pasan directamente al cliente
    serverSock.on('data', (d: Buffer) => clientSock.write(d));
  });
}

function startProxy(): void {
  // Precalentar contexto por defecto (fallback sin SNI)
  const defaultCtx = genLeafContext('localhost');

  const server = tls.createServer({
    ...defaultCtx,
    SNICallback: (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => {
      try {
        cb(null, genLeafContext(servername || 'localhost'));
      } catch (e: any) {
        cb(e);
      }
    },
    minVersion: 'TLSv1.2',
  });

  server.on('secureConnection', handleConnection);
  server.on('error', (err: Error) => log(`Proxy error: ${err.message}`));
  server.listen(443, '0.0.0.0', () => log('TLS proxy escuchando en :443'));
}

// ════════════════════════════════════════════════════════════════════════════
//  MENÚ INTERACTIVO (raw keyboard input)
// ════════════════════════════════════════════════════════════════════════════

function drawMenu(): void {
  print(CLEAR);
  println(
    `${CYAN}${BOLD}` +
    '  ┌─────────────────────────────────────────────┐\n' +
    '  │ Glow Proxy    https://discord.gg/Q4hEVkJ67J │\n' +
    '  └─────────────────────────────────────────────┘' +
    RESET
  );
  println();

  // Estado INTERCEPT
  if (interceptEnabled) {
    println(`  ${GREEN}${BOLD}[1] Intercept: ON ${RESET}`);
  } else {
    println(`  ${RED}${BOLD}[1] Intercept: OFF${RESET}`);
  }
  println();

  // PATH activo
  println(`  PATH:       ${YELLOW}${interceptPath || '(none)'}${RESET}`);

  // Fichero JSON
  const dispJSON = jsonFilePath ? path.basename(jsonFilePath) : 'No file selected';
  println(`  JSON:       ${YELLOW}${dispJSON}${RESET}`);

  // Estadísticas
  println(
    `  STATS:      ${CYAN}${interceptedCount} requests intercepted${RESET}` +
    ` / ${totalCount} total requests`
  );

  println();
  println('  ─────────────────────────────────────');
  println(`  ${BOLD}[2]${RESET} Change intercept path`);
  println(`  ${BOLD}[3]${RESET} Select JSON file`);
  println(`  ${BOLD}[4] / Q${RESET}  Exit`);
  println('  ─────────────────────────────────────');
  println();

  updateTitle();
}

function scheduleRedraw(): void {
  if (redrawTimer) return;
  redrawTimer = setTimeout(() => {
    redrawTimer = null;
    drawMenu();
  }, 80);
}

/** Lee una línea del usuario desactivando temporalmente el modo raw. */
function readLineFromUser(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    // Salir del modo raw
    if (process.stdin.isTTY) process.stdin.setRawMode(false);

    const rl = readline.createInterface({
      input:  process.stdin,
      output: process.stdout,
    });

    rl.question(prompt, (answer) => {
      rl.close();
      // Volver al modo raw
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      resolve(answer.trim());
    });
  });
}

async function startMenu(): Promise<void> {
  drawMenu();

  if (!process.stdin.isTTY) {
    log('WARN: stdin no es una TTY — el menú interactivo no estará disponible.');
    return;
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', async (key: string) => {
    const k = key.toLowerCase();

    if (k === '\x03' /* Ctrl-C */ || k === '4' || k === 'q') {
      println(`\n  ${YELLOW}Restoring DNS…${RESET}`);
      restoreWindowsDNS();
      process.exit(0);
    }

    if (k === '1') {
      interceptEnabled = !interceptEnabled;
      updateTitle();
      drawMenu();
      return;
    }

    if (k === '2') {
      // Cambiar path de intercept
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      drawMenu();
      const newPath = await readLineFromUser(
        `${YELLOW}  New path (current: ${interceptPath || '(none)'}): ${RESET}`
      );
      interceptPath = newPath;
      log(`Intercept path → "${interceptPath}"`);
      drawMenu();
      return;
    }

    if (k === '3') {
      // Seleccionar fichero JSON
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      println(`\n  ${CYAN}Abriendo selector de fichero…${RESET}`);
      const picked = pickJSONFile();
      if (picked) {
        jsonFilePath = picked;
        log(`JSON changed to: ${picked}`);
      }
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      drawMenu();
      return;
    }
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  PUNTO DE ENTRADA
// ════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {

  // ── 1. Admin check ──────────────────────────────────────────────────────
  if (!isAdmin()) {
    println('Admin attempt...');
    relaunchAsAdmin();
    process.exit(0);
  }

  // ── 2. ANSI + título inicial ─────────────────────────────────────────────
  enableANSI();
  setConsoleTitle('Glow proxy: [OFF]');
  print(CLEAR);
  println(
    `${CYAN}${BOLD}` +
    '  ┌─────────────────────────────────────────────┐\n' +
    '  │ Glow Proxy    https://discord.gg/Q4hEVkJ67J │\n' +
    '  └─────────────────────────────────────────────┘' +
    RESET
  );
  println();

  // ── 3. Selección de fichero JSON ─────────────────────────────────────────
  const picked = pickJSONFile();
  if (!picked) {
    println('  No file selected');
  } else {
    jsonFilePath = picked;
    log(`JSON: ${jsonFilePath}`);
    println(`  ${GREEN}  ${path.basename(jsonFilePath)}${RESET}`);
  }

  // ── 4. Cargar / generar CA ───────────────────────────────────────────────
  print('  Loading CA certificate... ');
  try {
    loadOrGenCA();
    println(`${GREEN}OK${RESET}`);
  } catch (e: any) {
    println(`${RED}FAILED${RESET}`);
    println(`  ${RED}CA error: ${e.message}${RESET}`);
    await waitEnter();
    process.exit(1);
  }

  // ── 5. Instalar CA en el almacén de Windows si no está ──────────────────
  if (!isCACertInstalled()) {
    print('  Installing CA certificate... ');
    try {
      installCACert();
      log('CA certificate installed');
      println(`${GREEN}OK${RESET}`);
    } catch (e: any) {
      println(`${RED}FAILED${RESET}`);
      println(`  ${RED}certutil failed: ${e.message}${RESET}`);
      await waitEnter();
      process.exit(1);
    }
  } else {
    log('CA certificate already installed');
    println(`  ${GREEN}CA already trusted${RESET}`);
  }

  // ── 6. Servidor DNS en :53 ───────────────────────────────────────────────
  print('  Starting server... ');
  try {
    startDNSServer();
    println(`${GREEN}OK${RESET}`);
  } catch (e: any) {
    println(`${RED}FAILED${RESET}`);
    println(`  ${RED}DNS server failed: ${e.message}${RESET}`);
    await waitEnter();
    process.exit(1);
  }

  // ── 7. Apuntar DNS de Windows a 127.0.0.1 ───────────────────────────────
  print('  Configuring Windows DNS... ');
  try {
    setWindowsDNS();
    execSync('ipconfig /flushdns', { stdio: 'pipe' });
    println(`${GREEN}OK${RESET}`);
  } catch (e: any) {
    println(`${YELLOW}WARNING: ${e.message}${RESET}`);
  }

  // ── 8. Listener TLS en :443 ──────────────────────────────────────────────
  print('  Starting TLS proxy on :443... ');
  try {
    startProxy();
    println(`${GREEN}OK${RESET}`);
  } catch (e: any) {
    println(`${RED}FAILED${RESET}`);
    println(`  ${RED}TLS proxy listen failed: ${e.message}${RESET}`);
    restoreWindowsDNS();
    await waitEnter();
    process.exit(1);
  }

  // ── 9. Handler Ctrl-C global ─────────────────────────────────────────────
  process.on('SIGINT', () => {
    println(`\n  ${YELLOW}Restoring DNS…${RESET}`);
    restoreWindowsDNS();
    process.exit(0);
  });

  // ── 10. Menú interactivo ─────────────────────────────────────────────────
  await new Promise(r => setTimeout(r, 300));
  await startMenu();
}

main().catch((e: Error) => {
  println(`${RED}Fatal: ${e.message}${RESET}`);
  process.exit(1);
});
