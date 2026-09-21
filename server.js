// Local WebSynapse server and Windows HID bridge host. Uses Node.js built-ins.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname);
const port = Number(process.env.WEBSYNAPSE_PORT || 8000);
const bridgeScript = path.join(root, 'native-bridge.ps1');
const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
};

let bridge = null;
let bridgeBuffer = '';
let bridgeFailure = null;
let nextBridgeRequestId = 1;
const pendingBridgeRequests = new Map();

function rejectPendingBridgeRequests(error) {
    for (const { reject } of pendingBridgeRequests.values()) reject(error);
    pendingBridgeRequests.clear();
}

function stopBridge() {
    const child = bridge;
    bridge = null;
    if (child && !child.killed) child.kill();
    rejectPendingBridgeRequests(new Error('The local Windows HID bridge stopped. Restart WebSynapse and try again.'));
}

function processBridgeOutput(chunk) {
    bridgeBuffer += chunk;
    let newline;
    while ((newline = bridgeBuffer.indexOf('\n')) !== -1) {
        const line = bridgeBuffer.slice(0, newline).trim();
        bridgeBuffer = bridgeBuffer.slice(newline + 1);
        if (!line) continue;

        let message;
        try {
            message = JSON.parse(line);
        } catch {
            bridgeFailure = `The Windows HID bridge returned an invalid response: ${line}`;
            continue;
        }

        const pending = pendingBridgeRequests.get(message.id);
        if (pending) {
            pendingBridgeRequests.delete(message.id);
            pending.resolve(message);
        }
    }
}

function startBridge() {
    if (bridge) return bridge;
    bridgeFailure = null;
    bridgeBuffer = '';

    const child = spawn('pwsh.exe', ['-NoProfile', '-File', bridgeScript], {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
    });
    bridge = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', processBridgeOutput);
    child.stderr.on('data', data => {
        bridgeFailure = String(data).trim() || bridgeFailure;
    });
    child.on('error', error => {
        bridgeFailure = `Could not start the Windows HID bridge: ${error.message}`;
        if (bridge === child) bridge = null;
        rejectPendingBridgeRequests(new Error(bridgeFailure));
    });
    child.on('close', code => {
        if (bridge === child) bridge = null;
        const message = bridgeFailure || `The Windows HID bridge exited (${code ?? 'unknown'}).`;
        rejectPendingBridgeRequests(new Error(message));
    });
    return child;
}

function sendBridgeCommand(command, extra = {}) {
    const child = startBridge();
    if (!child.stdin || child.stdin.destroyed) {
        return Promise.reject(new Error(bridgeFailure || 'The Windows HID bridge is unavailable.'));
    }

    const id = nextBridgeRequestId++;
    return new Promise((resolve, reject) => {
        pendingBridgeRequests.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, command, ...extra })}\n`, error => {
            if (!error) return;
            pendingBridgeRequests.delete(id);
            reject(new Error(`Could not send a command to the Windows HID bridge: ${error.message}`));
        });
    });
}

function sendJson(response, status, body) {
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    response.end(JSON.stringify(body));
}

function readJson(request) {
    return new Promise((resolve, reject) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk => {
            body += chunk;
            if (body.length > 16 * 1024) {
                const error = new Error('Request body is too large.');
                error.statusCode = 413;
                reject(error);
                request.destroy();
            }
        });
        request.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                const error = new Error('Request body must be valid JSON.');
                error.statusCode = 400;
                reject(error);
            }
        });
        request.on('error', reject);
    });
}

async function handleApi(request, response, pathname) {
    let command;
    let extra = {};
    if (request.method === 'GET' && pathname === '/api/hid/status') command = 'status';
    if (request.method === 'POST' && pathname === '/api/hid/connect') command = 'connect';
    if (request.method === 'POST' && pathname === '/api/hid/disconnect') command = 'disconnect';
    if (request.method === 'POST' && pathname === '/api/hid/set') {
        command = 'setFeature';
        const body = await readJson(request);
        if (typeof body.report !== 'string') {
            sendJson(response, 400, { ok: false, error: 'A base64 feature report is required.' });
            return;
        }
        extra = { report: body.report };
    }
    if (request.method === 'POST' && pathname === '/api/hid/get') command = 'getFeature';

    if (!command) {
        sendJson(response, 404, { ok: false, error: 'Unknown HID bridge endpoint.' });
        return;
    }

    try {
        const result = await sendBridgeCommand(command, extra);
        sendJson(response, result.ok ? 200 : 409, result);
    } catch (error) {
        sendJson(response, 503, { ok: false, error: error.message });
    }
}

function handleStatic(request, response, pathname) {
    if (pathname === '/favicon.ico') {
        response.writeHead(204, { 'Cache-Control': 'no-store' });
        response.end();
        return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(405);
        response.end('Method not allowed');
        return;
    }

    const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
    const filePath = path.resolve(root, relativePath);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
    }

    fs.stat(filePath, (statError, stats) => {
        if (statError || !stats.isFile()) {
            response.writeHead(404);
            response.end('Not found');
            return;
        }
        response.writeHead(200, {
            'Content-Type': contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store'
        });
        if (request.method === 'HEAD') response.end();
        else fs.createReadStream(filePath).pipe(response);
    });
}

const server = http.createServer(async (request, response) => {
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
        response.writeHead(400);
        response.end('Bad request');
        return;
    }

    try {
        if (pathname.startsWith('/api/hid/')) await handleApi(request, response, pathname);
        else handleStatic(request, response, pathname);
    } catch (error) {
        sendJson(response, error.statusCode || 500, { ok: false, error: error.message || 'Server error.' });
    }
});

function shutdown() {
    stopBridge();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(port, '127.0.0.1', () => {
    console.log(`WebSynapse is running at http://localhost:${port}`);
    console.log('The Windows HID bridge starts automatically when you connect. Press Ctrl+C to stop the server.');
});
