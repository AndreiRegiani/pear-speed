# pear-speed

Peer-to-peer network speed test powered by Hyperswarm.

## Usage

```console
$ pear-speed
```

Peers join the public lobby by default.

## Private lobbies

```console
$ pear-speed --lobby "any secret"
```

The lobby name is hashed into an isolated 32-byte Hyperswarm topic.

## Options

| Option            | Description          |
| ----------------- | -------------------- |
| `--lobby <name>`  | Join a private lobby |
| `--version`, `-v` | Show the version     |
| `--help`, `-h`    | Show help            |

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
