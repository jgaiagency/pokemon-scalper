import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  NTP_UNIX_EPOCH_SECONDS,
  createNtpTransport,
  ntpTimestampToUnixMs,
  writeNtpTimestamp,
} from '../../../src/scalper/transports/ntp.mjs';

class FakeSocket extends EventEmitter {
  constructor(onSend) {
    super();
    this.onSend = onSend;
    this.closed = false;
  }
  send(packet, port, host, callback) {
    this.packet = packet;
    this.port = port;
    this.host = host;
    callback?.();
    this.onSend?.(this, packet);
  }
  close() { this.closed = true; }
}

function responseFor(request, { receiveMs, transmitMs, version = 4, length = 48 } = {}) {
  const response = Buffer.alloc(length);
  if (length >= 1) response[0] = (version << 3) | 4;
  if (length >= 48) {
    request.copy(response, 24, 40, 48);
    writeNtpTimestamp(response, 32, receiveMs);
    writeNtpTimestamp(response, 40, transmitMs);
  }
  return response;
}

test('NTP transport sends an NTPv4 client request and computes offset and round trip', async () => {
  let monotonic = 10_000;
  const socket = new FakeSocket((instance, request) => {
    assert.equal(request.length, 48);
    assert.equal(request[0], 0x23);
    assert.equal(instance.port, 123);
    monotonic = 10_100;
    queueMicrotask(() => instance.emit('message', responseFor(request, { receiveMs: 1_000_030, transmitMs: 1_000_040 })));
  });
  const transport = createNtpTransport({
    socketFactory: () => socket,
    wallNow: () => 1_000_000,
    monotonicNow: () => monotonic,
  });

  const sample = await transport.query('time.example.test');
  assert.equal(sample.offsetMs, -15);
  assert.equal(sample.roundTripMs, 90);
  assert.equal(socket.closed, true);
});

test('NTP epoch conversion maps the Unix epoch exactly', () => {
  const packet = Buffer.alloc(8);
  packet.writeUInt32BE(NTP_UNIX_EPOCH_SECONDS, 0);
  packet.writeUInt32BE(0, 4);
  assert.equal(ntpTimestampToUnixMs(packet, 0), 0);
});

test('NTP query times out and closes its socket when no response arrives', async () => {
  const socket = new FakeSocket();
  const transport = createNtpTransport({ socketFactory: () => socket, timeoutMs: 5 });
  await assert.rejects(transport.query('silent.example.test'), /timed out/i);
  assert.equal(socket.closed, true);
});

test('NTP rejects short responses and unsupported protocol versions', async (t) => {
  await t.test('short response', async () => {
    const socket = new FakeSocket((instance, request) => queueMicrotask(() => instance.emit('message', responseFor(request, { length: 20 }))));
    await assert.rejects(createNtpTransport({ socketFactory: () => socket }).query('bad.example.test'), /48 bytes/);
  });
  await t.test('bad version', async () => {
    const socket = new FakeSocket((instance, request) => queueMicrotask(() => instance.emit('message', responseFor(request, { receiveMs: 1, transmitMs: 2, version: 2 }))));
    await assert.rejects(createNtpTransport({ socketFactory: () => socket }).query('bad.example.test'), /version/i);
  });
});
