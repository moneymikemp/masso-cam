'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = __dirname;

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json',
};

http.createServer((req, res) => {
  let filePath = path.join(root, req.url.split('?')[0]);
  if (filePath.endsWith('/') || !path.extname(filePath)) filePath += '/index.html';
  try {
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(fs.readFileSync(filePath));
  } catch {
    res.writeHead(404);
    res.end('Not found: ' + req.url);
  }
}).listen(9191, () => console.log('Harness server running at http://localhost:9191/src/renderer/cam/medialaxis-test.html'));
