# pear-speed protocol

Each app joins a Hyperswarm topic, finds peers through the DHT, and exchanges test data over Hyperswarm's encrypted duplex streams. Every app can start a test and serve another app's test. No central test server is involved.

## Topics and discovery

The public topic is the 32 byte result of `SHA256(UTF8("pear-speed/public/v1\0"))`.

A private lobby uses `SHA256(UTF8("pear-speed/lobby/v1\0" + String(name)))`. Use the exact lobby name, including case and spaces. The `\0` byte is part of the prefix. The public and private prefixes keep their topics separate.

Peers on the same topic can discover each other. Peers on different topics cannot. A lobby name selects a topic, but does not authenticate peers who know that name.

Join the topic with `client: true` and `server: true`. The official app binds the DHT before joining, refreshes discovery every 2 seconds, and keeps up to 32 peer connections. A blind relay or custom DHT bootstrap changes how peers connect, but does not change the topic or stream protocol.

## Connection and messages

Both peers send the ASCII bytes `pear-speed/3` as soon as the stream opens. A peer is ready after receiving the same bytes. This is the protocol version check.

Messages have no length prefix or newline. The control tokens are `pear-speed/download`, `pear-speed/upload`, and `pear-speed/stop`. Test data is a stream of `0x00` bytes, written in 65,536 byte blocks. Read tokens across chunk boundaries and handle extra bytes in the same chunk. Respect stream backpressure when writing.

## Test flow

An idle peer starts a test by sending `pear-speed/download`. It is the initiator. The other peer is the responder.

1. The responder sends zeros continuously. The initiator counts received bytes for 8 seconds.
2. The initiator sends `pear-speed/upload` and starts sending zeros. The responder stops sending and counts received bytes. This phase lasts 8 seconds.
3. The initiator sends `pear-speed/stop`. The responder replies with one UTF8 JSON object, such as `{"type":"result","downloaded":65536,"uploaded":65536}`. `downloaded` is the number of bytes the responder sent. `uploaded` is the number it received. Both peers can then use the connection for another test.

The initiator may still receive zeros sent before the responder saw `upload`. It counts these during verification, before the JSON reply. The reply has no separate delimiter. Its first byte is nonzero, so it follows the zero data in the stream. It can arrive in several chunks. The official app accepts at most 1,024 reply bytes.

The initiator checks that both reported counts equal its own received and sent counts. It calculates download speed from bytes received during the first phase and upload speed from confirmed bytes during the second phase. An unverified upload contributes zero to the reported upload speed. A test can run against several idle peers at once, then sum their rates.

## Concurrent tests and limits

If both peers send `pear-speed/download` at the same time, compare their Hyperswarm public keys as byte arrays. The peer with the smaller key keeps its test. The other peer drops its test on that connection and serves the smaller key peer. The smaller key peer consumes the incoming `download` token and waits for zero data.

The official app closes a stream if an incoming chunk exceeds 65,536 bytes or a token is invalid. It allows 10 seconds for the hello and 10 seconds to finish an idle request once started. A service session has a 30 second limit. The result reply has a 10 second limit. A lost connection or mismatched counts leave that peer's result unverified.
