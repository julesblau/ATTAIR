import http from 'node:http';
import handler from 'serve-handler';

const port = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) =>
  handler(req, res, {
    public: 'dist',
    rewrites: [{ source: '**', destination: '/index.html' }],
    headers: [
      {
        source: 'assets/**',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ],
  })
);

server.listen(port, () => {
  console.log(`attair-app listening on :${port}`);
});
