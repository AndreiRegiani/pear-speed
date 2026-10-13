# pear-speed

P2P speed-test powered by [Hyperswarm](https://github.com/holepunchto/hyperswarm) and [Bare](https://github.com/holepunchto/bare).

<img width="799" height="412" alt="image" src="https://github.com/user-attachments/assets/ef6ec733-fbc8-4286-bc1d-fcdd60aca3e7" />

## P2P Architecture

There is no central speed-test server. Every `pear-speed` instance joins the same 32-byte Hyperswarm topic as both a client and a server. The DHT handles discovery and NAT hole punching, then peers exchange test traffic over end-to-end Noise-encrypted duplex streams.

## Usage

Peers join the public lobby by default.

```console
$ pear-speed
```

## Private lobbies

```console
$ pear-speed --lobby "any secret"
```

The lobby name is hashed with a namespace prefix to become a 32-byte Hyperswarm topic.

## Development

Install [Bare](https://github.com/holepunchto/bare) JS runtime and dependencies:

```console
npm i -g bare
npm ci
```

Run:

```sh
bare index.js
```

## CLI Options

| Option                 | Description                            |
| ---------------------- | -------------------------------------- |
| `--lobby <name>`       | Join a private lobby                   |
| `--relay <public-key>` | Use a blind relay for peer connections |
| `--version`, `-v`      | Show the version                       |
| `--help`, `-h`         | Show help                              |

## Tests

```sh
npm run lint
npm test
```

## Stack

- [`hyperswarm`](https://github.com/holepunchto/hyperswarm): peer discovery and encrypted connections.
- [`bare-tui`](https://github.com/holepunchto/bare-tui): terminal interface (TUI).
- [`paparam`](https://github.com/holepunchto/paparam): CLI argument parsing.

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

## Blind relay

On networks where direct P2P connections are restricted, use [pear](https://github.com/holepunchto/pear) to start a blind-relay server on another network (`$ pear blind-relay`), then run a pear-speed client thru that network:

```console
$ pear-speed --relay <public-key>
```

## License

Apache-2.0
