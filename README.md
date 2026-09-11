# pear-speed

Peer-to-peer network speed test.

## Installation

```console
npx pear-install ...
```

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

| Option                 | Description                            |
| ---------------------- | -------------------------------------- |
| `--lobby <name>`       | Join a private lobby                   |
| `--relay <public-key>` | Use a blind relay for peer connections |
| `--version`, `-v`      | Show the version                       |
| `--help`, `-h`         | Show help                              |

## Blind relay

On networks where direct P2P connections are restricted, use [pear](https://github.com/holepunchto/pear) to start a blind-relay server on another network (`$ pear blind-relay`), then run a pear-speed client thru that network:

```console
$ pear-speed --relay <public-key>
```

## Architecture

There is no central speed-test server. Every `pear-speed` instance joins the same 32-byte Hyperswarm topic as both a client and a server. The DHT handles discovery and NAT hole punching, then peers exchange test traffic over end-to-end Noise-encrypted duplex streams.

After a handshake, peers exchange zero-filled 64 KiB buffers for eight seconds in each direction. Stream backpressure controls the flow, and matching byte counts verify the result.

A test uses up to 32 idle peers at once, prefers lower-latency connections, and sums their verified rates to help saturate fast links. DHT nodes only help peers discover and connect; no application server handles test traffic.

## Dependencies

- [`hyperswarm`](https://github.com/holepunchto/hyperswarm): peer discovery and encrypted connections.
- [`bare-tui`](https://github.com/holepunchto/bare-tui): terminal interface.
- [`pear-runtime`](https://github.com/holepunchto/pear-runtime): automatic updates.
- [`paparam`](https://github.com/holepunchto/paparam): CLI argument parsing.

## Development

Install Bare runtime:

```console
npm i -g bare
```

Install project dependencies:

```sh
npm ci
```

Run locally without OTA updates:

```sh
npm start
```

## Tests

```sh
npm run lint
npm test
```

## Standalone builds

```sh
npm run make
```

Standalone builds are written to `out/<platform>-<arch>/pear-speed`.

## Supported platforms

| Platform | x86_64 | arm64 |
| -------- | ------ | ----- |
| Linux    | ✔️     | ✔️    |
| macOS    | ✔️     | ✔️    |
| Windows  | ✔️     | ✔️    |

## License

Apache-2.0
