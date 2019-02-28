[![Build Status](https://travis-ci.org/Novage/wt-tracker.svg?branch=master)](https://travis-ci.org/Novage/wt-tracker)
[![Coverage Status](https://coveralls.io/repos/github/Novage/wt-tracker/badge.svg?branch=master)](https://coveralls.io/github/Novage/wt-tracker?branch=master)
# wt-tracker
High-performance WebTorrent tracker

## Related projects

* [p2p-media-loader](https://github.com/Novage/p2p-media-loader) - an open-source engine for P2P streaming of live and on demand video directly in a web browser HTML page
* [WebTorrent](https://github.com/webtorrent/webtorrent) - streaming torrent client for the web https://webtorrent.io
* [uWebSockets.js](https://github.com/uNetworking/uWebSockets.js) - TypeScript web server - 15x faster than Deno

## Build instructions

Node.js 10.x or 11.x is required.

```sh
npm install
npm run build
```

## Run instructions

```sh
node dist/run-uws-tracker.js [config.json]
```

or

```sh
npm start [config.json]
```

## Configuration

See [config.json](sample/config.json).

## Statistics
Under `/stats.json` URL
