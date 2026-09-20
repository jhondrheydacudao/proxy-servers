const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const port = Number(process.env.PORT || 10000);
const upstreamBaseUrl =
  process.env.UPDATE_API_BASE_URL ||
  'https://updater-servers.onrender.com/api/app-update/';
const distDirectory = path.join(__dirname, 'dist');

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml; charset=utf-8',
};

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

function proxyRequest(request, response, upstreamPath, transformResponse) {
  const upstreamUrl = new URL(upstreamPath, upstreamBaseUrl);

  const upstreamRequest = https.request(
    upstreamUrl,
    {
      method: request.method,
      headers: {
        Accept: request.headers.accept || '*/*',
        'User-Agent': 'Anilove proxy',
      },
    },
    (upstreamResponse) => {
      response.statusCode = upstreamResponse.statusCode || 502;

      if (
        transformResponse &&
        request.method === 'GET' &&
        upstreamResponse.statusCode === 200
      ) {
        let body = '';

        upstreamResponse.setEncoding('utf8');
        upstreamResponse.on('data', (chunk) => {
          body += chunk;
        });

        upstreamResponse.on('end', () => {
          try {
            const payload = transformResponse(JSON.parse(body));
            sendJson(response, 200, payload);
          } catch {
            sendJson(response, 502, {
              error: 'Invalid upstream release response',
            });
          }
        });

        return;
      }

      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (
          value !== undefined &&
          name !== 'access-control-allow-origin'
        ) {
          response.setHeader(name, value);
        }
      }

      upstreamResponse.pipe(response);
    },
  );

  upstreamRequest.setTimeout(15000, () => {
    upstreamRequest.destroy(new Error('Upstream request timed out'));
  });

  upstreamRequest.on('error', () => {
    if (!response.headersSent) {
      sendJson(response, 502, {
        error: 'Upstream release service unavailable',
      });
    } else {
      response.destroy();
    }
  });

  request.pipe(upstreamRequest);
}

function serveStatic(request, response) {
  const requestPath = new URL(request.url, 'http://localhost').pathname;
  const relativePath =
    requestPath === '/' ? 'index.html' : requestPath.slice(1);
  const filePath = path.resolve(distDirectory, relativePath);

  if (!filePath.startsWith(`${distDirectory}${path.sep}`)) {
    response.statusCode = 400;
    response.end('Bad request');
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      response.statusCode = 404;
      response.end('Not found');
      return;
    }

    response.statusCode = 200;
    response.setHeader(
      'Content-Type',
      contentTypes[path.extname(filePath).toLowerCase()] ||
        'application/octet-stream',
    );

    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    fs.createReadStream(filePath).pipe(response);
  });
}

const server = http.createServer((request, response) => {
  const requestPath = new URL(request.url, 'http://localhost').pathname;
  const isReadRequest =
    request.method === 'GET' || request.method === 'HEAD';

  if (
    isReadRequest &&
    requestPath === '/api/app-update/latest'
  ) {
    proxyRequest(request, response, 'latest', (release) => ({
      ...release,
      downloadUrl: '/api/app-update/download',
    }));
    return;
  }

  if (
    isReadRequest &&
    requestPath === '/api/app-update/download'
  ) {
    proxyRequest(request, response, 'download');
    return;
  }

  if (isReadRequest) {
    serveStatic(request, response);
    return;
  }

  response.setHeader('Allow', 'GET, HEAD');
  response.statusCode = 405;
  response.end('Method not allowed');
});

server.listen(port, () => {
  console.log(`Anilove proxy listening on port ${port}`);
});
