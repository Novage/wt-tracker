# WebTorrent Tracker - Setup & Run Guide

## Project Overview
**wt-tracker** is a high-performance WebTorrent tracker that handles WebRTC signaling for peer-to-peer networks in web browsers.

### Key Features
- Handles up to 30k WebSocket Secure (HTTPS) peers
- Supports ws:// (HTTP) and wss:// (HTTPS) connections
- IPv4 and IPv6 support
- 100% TypeScript with full CI/test coverage
- Statistics endpoint at `/stats.json`

## System Requirements
- **Node.js**: 22.18.0+ (or Node 20+)
- **npm**: 10.x or higher
- **Port**: 3000 (default, configurable in config.json)

## Installation & Setup

### 1. Install Dependencies
```bash
cd /home/technonext/Documents/wt-tracker
npm install
```

### 2. Configure (Optional)
Edit `config.json` to customize:
- Server port and host
- WebSocket settings (compression, timeout, max connections)
- Tracker announce interval and max offers

## Running the Tracker

### Option 1: Using npm (Recommended)
```bash
npm start
```

### Option 2: Using Node directly
```bash
node src/run-tracker.ts [config.json]
```

### Option 3: Build & Run compiled version
```bash
npm run compile
node lib/run-tracker.js [config.json]
```

### Option 4: Worker Demo (Multi-core)
```bash
npm run start:worker-demo
```

## Verification

### Check if tracker is running
```bash
curl http://127.0.0.1:3000/stats.json
```

### Sample Response
```json
{
  "torrentsCount": 0,
  "peersCount": 0,
  "servers": [
    {
      "server": "127.0.0.1:3000",
      "webSocketsCount": 0
    }
  ],
  "memory": {
    "rss": 87003136,
    "heapTotal": 10670080,
    "heapUsed": 8809744,
    "external": 8371994,
    "arrayBuffers": 18675
  }
}
```

## Available npm Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Start the tracker (direct TypeScript) |
| `npm run start:worker-demo` | Start with worker threads for multi-core |
| `npm run build` | Build: lint + clean + compile |
| `npm run compile` | Compile TypeScript to JavaScript |
| `npm run lint` | Run ESLint static analysis |
| `npm run test` | Run unit tests with Vitest |
| `npm run test:coverage` | Run tests with coverage report |
| `npm run clean` | Remove compiled lib/ directory |

## Configuration Options

See `sample/config.json` for full configuration options:

- **servers**: Array of server configurations (HTTP/HTTPS)
- **servers[].server.port**: Port number (default: 8000)
- **servers[].server.host**: Bind address (default: 0.0.0.0)
- **servers[].websockets**: WebSocket settings
  - **path**: URL pattern (default: "/*")
  - **maxPayloadLength**: Max message size in bytes
  - **idleTimeout**: Connection idle timeout in seconds
  - **compression**: 0=none, 1=shared, 2=dedicated
  - **maxConnections**: Max concurrent connections (0=unlimited)
- **tracker.maxOffers**: Max WebRTC SDP offers to process
- **tracker.announceInterval**: Desired announce interval in seconds

## Stopping the Tracker

```bash
# If running in foreground
Ctrl+C

# If running in background
pkill -f "npm start"
```

## Troubleshooting

### Port Already in Use
If port 3000 (or configured port) is busy:
1. Change port in `config.json`
2. Or kill the process: `pkill -f "npm start"`

### Node Version Mismatch
Ensure Node.js 22+ is installed:
```bash
node --version  # Should show v22.x.x or higher
```

### uWebSockets Build Issues
The project requires glibc for uWebSockets. If using Alpine Linux, use a Debian-based container.

## Performance Notes
- The tracker can handle 30,000+ concurrent WebSocket connections
- Memory footprint: ~85MB for idle tracker
- CPU efficient due to libuv-based async I/O

## Integration with P2P Applications
- Use WebSocket endpoint: `ws://127.0.0.1:3000/` or `wss://yourdomain:8443/`
- For secure connections, configure SSL certificates in config.json
- For P2P Media Loader, specify tracker URL in client initialization

## Related Resources
- [WebTorrent](https://github.com/webtorrent/webtorrent)
- [P2P Media Loader](https://github.com/Novage/p2p-media-loader)
- [uWebSockets.js](https://github.com/uNetworking/uWebSockets.js)
