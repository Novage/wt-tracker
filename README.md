[![Build Status](https://github.com/Novage/wt-tracker/actions/workflows/main.yml/badge.svg)](https://github.com/Novage/wt-tracker/actions/workflows/main.yml)
[![Coverage Status](https://coveralls.io/repos/github/Novage/wt-tracker/badge.svg?branch=main)](https://coveralls.io/github/Novage/wt-tracker?branch=main)

# wt-tracker

High-performance WebTorrent tracker.

WebTorrent tracker is a required component of [WebTorrent](https://github.com/webtorrent/webtorrent) and [P2P Media Loader](https://github.com/Novage/p2p-media-loader) (peer-to-peer networks for web browsers) to do [WebRTC](https://en.wikipedia.org/wiki/WebRTC) signaling - exchanging connection data (i.e. [SDP](https://en.wikipedia.org/wiki/Session_Description_Protocol)) between peers - joining them into swarms.

## Features

- handles more than 40k WebSocket Secure (HTTPS) peers on a VPS with only 2 GiB memory and 1 virtual CPU thanks to [uWebSockets.js](https://github.com/uNetworking/uWebSockets.js) I/O backend and perfomance optimizations in the code
- handles ws:// (HTTP) and wss:// (HTTPS) connections simultaneously
- IPv4 and IPv6 support
- robust and well-tested: CI, unit tests, static code analyzis, 100% TypeScript
- supports tracker "scrape" extension
- statistics under /stats.json URL

## Related projects

- [P2P Media Loader](https://github.com/Novage/p2p-media-loader) - an open-source engine for P2P streaming of live and on demand video directly in a web browser HTML page
- [Novage, LLC](https://novage.com.ua/) - P2P development, support & consulting
- [WebTorrent](https://github.com/webtorrent/webtorrent) - streaming torrent client for the web https://webtorrent.io
- [uWebSockets.js](https://github.com/uNetworking/uWebSockets.js) - the Node.js bindings to µWebSockets, one of the most efficient web servers available

## Build instructions

Node.js 16+ is required.

```sh
npm install
npm run build
```

## Run instructions

```sh
./bin/wt-tracker [config.json]
```

or

```sh
node lib/run-uws-tracker.js [config.json]
```

or

```sh
npm start [config.json]
```

## Configuration

See [config.json](sample/config.json)

| Name                                | Type   | Description                                                                                                                                                           |
| ----------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| servers.websockets.path             | string | URL pattern for the WebSockets endpoint                                                                                                                               |
| servers.websockets.maxPayloadLength | number | The maximum length of received message                                                                                                                                |
| servers.websockets.midleTimeout     | number | The maximum amount of seconds that may pass without sending or getting a message. Being idle for more than this, and the connection is severed.                       |
| servers.websockets.compression      | 0,1,2  | 0 = no compression, 1 = shared compressor, 2 = dedicated compressor (see [details](https://github.com/uNetworking/uWebSockets/blob/master/misc/READMORE.md#settings)) |
| servers.websockets.maxConnections   | number | The maximum number of WebSocket connections. 0 = no limit.                                                                                                            |
| tracker.maxOffers                   | number | The maximum number of client's WebRTC SDP offers that are processed                                                                                                   |
| tracker.announceInterval            | number | Desired announce interval in seconds required from the clients                                                                                                        |

## Index HTML page

You can specify a content of the index page by creating `index.html` file in the working directory.
