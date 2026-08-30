# pear-speed

P2P speed test.

## Client

```console
$ pear-speed  # defaults to public lobby server swarm
```

## Server

```console
# volunteer to public lobby
$ pear-speed server

# generate a topic for a private server lobby
$ pear-speed new-lobby
# Generated unique topic: <z32-topic>

# use generated topic to serve your private lobby
$ pear-speed server --lobby <z32-topic>

# clients can connect to it using the same topic
$ pear-speed --lobby <z32-topic>
```

## Client Options

| Option                | Description                    |
| --------------------- | ------------------------------ |
| `--lobby <z32-topic>` | Shared topic, default built-in |

## Server Options

| Option                  | Description                    |
| ----------------------- | ------------------------------ |
| `--lobby <z32-topic>`   | Shared topic, default built-in |
| `--connections <count>` | Concurrent tests, default `1`  |

## Architecture

Hyperswarm discovers peers and provides encrypted UDX streams transfering at maximum speed, ideally 5 servers in parallel to try exhausting client's network bandwidth.

## Dependencies

| Dependency       | Purpose                              |
| ---------------- | ------------------------------------ |
| `hyperswarm`     | Peer discovery and encrypted streams |
| `bare-tui`       | Interactive terminal interface       |
| `paparam`        | Command and flag parsing             |
| `pear-gracedown` | Graceful shutdown                    |
| `pear-runtime`   | P2P application updates              |
| `corestore`      | Update data storage                  |
| `framed-stream`  | Runtime worker IPC                   |
| `ip3country`     | Local IPv4 country lookup            |
| `b4a`, `bare-*`  | Bare runtime primitives              |

## Local Development

Install Bare:

```sh
npm i -g bare
```

Install dependencies and run:

```sh
npm ci
npm run client
npm run server
```

## Building standalone executables

```sh
npm run make
```

Standalone builds are written to `out/<platform>-<arch>/pear-speed`. Set the `upgrade` link in `package.json` (created with `pear touch`) to enable P2P OTA updates.

## Testing

```sh
npm run lint
npm run test
```

## License

Apache-2.0

## Credits

pear-speed uses the IP2Location LITE database for [IP geolocation](https://www.ip2location.com).
