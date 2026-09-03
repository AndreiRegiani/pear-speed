# pear-speed

Peer-to-peer network speed test.

## Usage

```console
$ pear-speed
```

Peers join the public lobby by default.

## Private lobbies

```console
$ pear-speed --lobby "any secret"
```

The lobby name is hashed with a namespace prefix to become a 32-byte Hyperswarm topic.

## Options

| Option            | Description          |
| ----------------- | -------------------- |
| `--lobby <name>`  | Join a private lobby |
| `--version`, `-v` | Show the version     |
| `--help`, `-h`    | Show help            |

## Architecture

There is no central speed-test server. Every `pear-speed` instance joins the same 32-byte Hyperswarm topic as both a client and a server. The DHT handles discovery and NAT hole punching, then peers exchange test traffic over end-to-end Noise-encrypted duplex streams.

After a handshake, peers exchange zero-filled 64 KiB buffers for eight seconds in each direction. Stream backpressure controls the flow, and matching byte counts verify the result.

A test uses up to 32 idle peers at once, prefers lower-latency connections, and sums their verified rates to help saturate fast links. DHT nodes only help peers discover and connect; no application server handles test traffic.

## Dependencies

- [`hyperswarm`](https://github.com/holepunchto/hyperswarm): peer discovery and encrypted connections.
- [`bare-tui`](https://github.com/holepunchto/bare-tui): terminal interface.
- [`pear-runtime`](https://github.com/holepunchto/pear-runtime): automatic updates.
- [`paparam`](https://github.com/holepunchto/paparam): CLI argument parsing.
- [`ip3country`](https://github.com/statsig-io/ip3country): country flags for public IP addresses.

## Development

Install dependencies and run locally:

```sh
npm ci
npm start
```

## Test

```sh
npm run lint
npm test
```

## Build

```sh
npm run make
```

Standalone builds are written to `out/<platform>-<arch>/pear-speed`.

## License

Apache-2.0
