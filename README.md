# pear-speed

Peer-to-peer network speed test.

```console
$ pear-speed
```

## Private lobbies

```console
$ pear-speed --lobby some-random-name
```

Lobby names are hashed into a private 32-byte Hyperwarm topic.

## CLI Options

| Option            | Description                |
| ----------------- | -------------------------- |
| `--lobby <name>`  | Defaults to public lobby   |
| `--version`, `-v` | Show the installed version |

## Local Development

Install Bare:

```sh
npm i -g bare
npm ci
npm start
```

## Building standalone executables

```sh
npm run make
```

Standalone builds are written to `out/<platform>-<arch>/pear-speed`.

## Testing

```sh
npm run lint
npm run test
```

## License

Apache-2.0

## Credits

pear-speed uses the bundled IP2Location LITE data ([source](https://lite.ip2location.com)) to display IP flags.
