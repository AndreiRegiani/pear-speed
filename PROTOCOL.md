# pear-speed protocol

Peers find each other through the DHT and test over encrypted Hyperswarm streams. Any peer can start or serve a test, there is no central test server.

## Topics and discovery

Public topic: `SHA256(UTF8("pear-speed/public/v1\0"))`. Private lobby: `SHA256(UTF8("pear-speed/lobby/v1\0" + String(name)))`. Both are 32 bytes. Names are case- and space-sensitive; `\0` is part of each prefix. The prefixes separate public and private topics. Only peers on the same topic discover each other. A lobby name is not authentication.

The app binds the DHT, joins with `client: true` and `server: true`, refreshes every 2 seconds, and keeps up to 32 connections. A blind relay or custom DHT bootstrap changes the route, not the protocol or topic.

## Connection and messages

Both peers send the ASCII version token `pear-speed/3` on connection and become ready on a match.

Commands are `pear-speed/download`, `pear-speed/upload`, and `pear-speed/stop`, with no length prefix or newline. Data is `0x00` bytes in 65,536-byte blocks. Tokens may span chunks; `download` may share a chunk with `hello`, and zeros with `upload`. Other trailing bytes are invalid. Writers respect backpressure.

## Test flow

An idle peer starts a test by sending `pear-speed/download`:

1. The responder streams zeros. The initiator counts received bytes for 8 seconds.
2. The initiator sends `pear-speed/upload` and writes zeros for 8 seconds. The responder stops writing and counts received bytes, including queued data delivered later.
3. The initiator sends `pear-speed/stop`. The responder replies with UTF-8 JSON, such as `{"type":"result","downloaded":65536,"uploaded":65536}`. `downloaded` counts bytes it wrote; `uploaded` counts bytes it received. The connection can then serve another test.

Zeros sent before the responder saw `upload` may arrive before the reply. The initiator counts them during verification. The JSON starts with a nonzero byte, has no delimiter, may span chunks, and is limited to 1,024 bytes.

The initiator checks the reply against its received and queued counts. Download speed is bytes received in the first phase divided by its measured duration. Upload speed is confirmed bytes across all peers divided by the longer of the local upload phase and the time from upload start to the last verified reply. This includes queued data draining after the send window. Unverified uploads count as zero.

A test uses all ready, idle peers and sends continuously. Enough capable peers can saturate the local connection. The result measures application payload throughput, which peers, paths, relays, or the device may limit. The app does not detect saturation.

## Concurrent tests and limits

If both peers send `pear-speed/download` together, the smaller Hyperswarm public key keeps its test. The other drops its test on that connection and serves the first peer. The first consumes the incoming `download` token and waits for zeros.

An invalid token or incoming chunk over 65,536 bytes closes the stream. Limits: 10-second socket timeout during `hello`, 10 seconds for a started idle request, 30 seconds for service, and 10 seconds for a reply. A disconnect before verification or mismatched counts leaves that peer unverified.
