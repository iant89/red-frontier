/**
 * Network transport adapter and wire encoding — Phase 30.
 *
 * Implements the network boundary abstraction:
 * Adapts between typed HostRequest/HostReply objects and raw serialized string packets
 * across any duplex stream (WebSocket, WebRTC DataChannel, TCP socket).
 *
 * The simulation and host layer remain 100% oblivious to whether they are communicating
 * within a process, across a Web Worker, or over a remote network boundary.
 */

import type { HostPort, HostReply, HostRequest } from './messages';

export interface NetworkDuplexChannel {
  send(packet: string): void;
  onmessage: ((packet: string) => void) | null;
  close?(): void;
}

/**
 * Creates a client-side HostPort adapting a raw string duplex network channel
 * into the structured HostPort interface expected by WorkerSimHost / NetworkSimHost.
 */
export function createNetworkHostPort(channel: NetworkDuplexChannel): HostPort {
  const port: HostPort = {
    postMessage(req: HostRequest): void {
      const packet = JSON.stringify(req);
      channel.send(packet);
    },
    set onmessage(handler: ((event: { data: HostReply }) => void) | null) {
      channel.onmessage = handler
        ? (packet: string) => {
            const data = JSON.parse(packet) as HostReply;
            handler({ data });
          }
        : null;
    },
    terminate(): void {
      channel.close?.();
    },
  };
  return port;
}

/**
 * Connects a server-side simulation runtime to a raw string duplex network channel.
 */
export function bindServerNetworkChannel(
  channel: NetworkDuplexChannel,
  runtime: { handle(req: HostRequest): void },
): void {
  channel.onmessage = (packet: string) => {
    const req = JSON.parse(packet) as HostRequest;
    runtime.handle(req);
  };
}

/**
 * In-memory simulated network channel for testing serialization, async latency,
 * and packet ordering across an explicit network seam.
 */
export function createSimulatedNetworkChannel(options?: {
  latencyMs?: number;
}): {
  clientChannel: NetworkDuplexChannel;
  serverChannel: NetworkDuplexChannel;
  flush(): Promise<void>;
} {
  const latency = options?.latencyMs ?? 0;
  const clientToServerQueue: string[] = [];
  const serverToClientQueue: string[] = [];

  const clientChannel: NetworkDuplexChannel = {
    send(packet: string) {
      // Ensure payload is valid JSON
      JSON.parse(packet);
      clientToServerQueue.push(packet);
      if (latency === 0) {
        queueMicrotask(() => deliverClientToServer());
      } else {
        setTimeout(() => deliverClientToServer(), latency);
      }
    },
    onmessage: null,
  };

  const serverChannel: NetworkDuplexChannel = {
    send(packet: string) {
      // Ensure payload is valid JSON
      JSON.parse(packet);
      serverToClientQueue.push(packet);
      if (latency === 0) {
        queueMicrotask(() => deliverServerToClient());
      } else {
        setTimeout(() => deliverServerToClient(), latency);
      }
    },
    onmessage: null,
  };

  function deliverClientToServer(): void {
    while (clientToServerQueue.length > 0) {
      const pkt = clientToServerQueue.shift()!;
      serverChannel.onmessage?.(pkt);
    }
  }

  function deliverServerToClient(): void {
    while (serverToClientQueue.length > 0) {
      const pkt = serverToClientQueue.shift()!;
      clientChannel.onmessage?.(pkt);
    }
  }

  return {
    clientChannel,
    serverChannel,
    async flush() {
      deliverClientToServer();
      deliverServerToClient();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}
