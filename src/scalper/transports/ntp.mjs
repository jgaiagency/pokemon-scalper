import { createSocket } from 'node:dgram';

export const NTP_UNIX_EPOCH_SECONDS = 2_208_988_800;
export const NTP_PORT = 123;
const NTP_PACKET_BYTES = 48;
const TWO_TO_32 = 2 ** 32;
const monotonicMs = () => Number(process.hrtime.bigint()) / 1_000_000;

export function ntpTimestampToUnixMs(buffer, offset = 0) {
  if (!Buffer.isBuffer(buffer) || buffer.length < offset + 8) throw new RangeError('NTP timestamp requires 8 bytes');
  const seconds = buffer.readUInt32BE(offset);
  const fraction = buffer.readUInt32BE(offset + 4);
  return (seconds - NTP_UNIX_EPOCH_SECONDS) * 1_000 + (fraction / TWO_TO_32) * 1_000;
}

export function writeNtpTimestamp(buffer, offset, unixMs) {
  if (!Buffer.isBuffer(buffer) || buffer.length < offset + 8) throw new RangeError('NTP timestamp requires 8 bytes');
  if (!Number.isFinite(unixMs)) throw new TypeError('unixMs must be finite');
  const unixSeconds = Math.floor(unixMs / 1_000);
  const remainderMs = unixMs - unixSeconds * 1_000;
  const fraction = Math.floor((remainderMs / 1_000) * TWO_TO_32);
  buffer.writeUInt32BE((unixSeconds + NTP_UNIX_EPOCH_SECONDS) >>> 0, offset);
  buffer.writeUInt32BE(fraction >>> 0, offset + 4);
  return buffer;
}

function closeSocket(socket) {
  try { socket.close(); } catch { /* The socket may not have bound yet. */ }
}

function preciseMs(value) {
  return Number(value.toFixed(6));
}

export function createNtpTransport({
  timeoutMs = 2_000,
  socketFactory = () => createSocket('udp4'),
  wallNow = Date.now,
  monotonicNow = monotonicMs,
  port = NTP_PORT,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be positive');

  return {
    query(source) {
      if (!source || typeof source !== 'string') return Promise.reject(new TypeError('NTP source must be a hostname'));
      return new Promise((resolve, reject) => {
        const socket = socketFactory('udp4');
        const request = Buffer.alloc(NTP_PACKET_BYTES);
        request[0] = 0x23; // LI=0, VN=4, Mode=3 (client)
        const sentEpochMs = wallNow();
        const sentMonotonicMs = monotonicNow();
        writeNtpTimestamp(request, 40, sentEpochMs);
        let settled = false;
        let timer;

        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.removeListener?.('message', onMessage);
          socket.removeListener?.('error', onError);
          closeSocket(socket);
          if (error) reject(error);
          else resolve(value);
        };
        const onError = (error) => finish(error);
        const onMessage = (response) => {
          try {
            if (!Buffer.isBuffer(response) || response.length !== NTP_PACKET_BYTES) {
              throw new Error(`Invalid NTP response: expected 48 bytes, received ${response?.length ?? 0}`);
            }
            const version = (response[0] >> 3) & 0x07;
            const mode = response[0] & 0x07;
            if (version !== 3 && version !== 4) throw new Error(`Invalid NTP version: ${version}`);
            if (mode !== 4 && mode !== 5) throw new Error(`Invalid NTP response mode: ${mode}`);

            const receivedEpochMs = sentEpochMs + (monotonicNow() - sentMonotonicMs);
            const serverReceiveMs = ntpTimestampToUnixMs(response, 32);
            const serverTransmitMs = ntpTimestampToUnixMs(response, 40);
            const offsetMs = ((serverReceiveMs - sentEpochMs) + (serverTransmitMs - receivedEpochMs)) / 2;
            const roundTripMs = (receivedEpochMs - sentEpochMs) - (serverTransmitMs - serverReceiveMs);
            finish(null, { offsetMs: preciseMs(offsetMs), roundTripMs: preciseMs(roundTripMs) });
          } catch (error) {
            finish(error);
          }
        };

        socket.once('message', onMessage);
        socket.once('error', onError);
        timer = setTimeout(() => finish(new Error(`NTP query to ${source} timed out after ${timeoutMs} ms`)), timeoutMs);
        socket.send(request, port, source, (error) => { if (error) finish(error); });
      });
    },
  };
}
