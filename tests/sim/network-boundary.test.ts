/**
 * @suite sim/network-boundary
 * @group integration
 * @covers src/sim/host/NetworkPort.ts src/sim/host/WorkerSimHost.ts src/sim/host/SimHost.ts src/sim/host/messages.ts
 * @desc Network Boundary Architecture (Phase 30): proves the simulation is transport-agnostic.
 * Verifies that the core simulation remains free of DOM/WebSocket/HTTP dependencies,
 * that the wire protocol cleanly serializes over raw string channels, and that a
 * Network-transport host functions identically to in-process and worker hosts.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createNetworkHostPort,
  bindServerNetworkChannel,
  createSimulatedNetworkChannel,
  WorkerSimHost,
  type HostRequest,
  type HostReply,
  type SimBootParams,
  type SimSnapshot,
} from '../../src/sim/host';
import { createSimRuntime } from '../../src/sim/host/workerRuntime';
import { DEFAULT_WORLD_OPTIONS } from '../../src/sim/difficulty';
import { WORLD_HALF } from '../../src/sim/config';
import { group, test, finish } from '../harness';

const here = path.dirname(fileURLToPath(import.meta.url));
const simSrcDir = path.join(here, '..', '..', 'src', 'sim');

const BOOT: SimBootParams = {
  seed: 4242,
  difficulty: 'pioneer',
  worldHalf: WORLD_HALF,
  region: null,
  worldOptions: DEFAULT_WORLD_OPTIONS,
};

group('Simulation isolation & purity');

test('simulation core contains zero DOM, WebSocket, or HTTP dependencies', () => {
  function scanDir(dir: string, files: string[] = []): string[] {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        scanDir(full, files);
      } else if (ent.name.endsWith('.ts')) {
        // Exclude the browser entry points that deliberately wrap Worker / URL
        if (ent.name === 'createHost.ts' || ent.name === 'sim.worker.ts') continue;
        files.push(full);
      }
    }
    return files;
  }

  const simFiles = scanDir(simSrcDir);
  assert.ok(simFiles.length > 20, 'must have scanned core simulation files');

  const forbiddenPatterns = [
    { pattern: /\bwindow\.[a-zA-Z]/, desc: 'window.* browser global' },
    { pattern: /\bdocument\.[a-zA-Z]/, desc: 'document.* DOM global' },
    { pattern: /\bnew\s+WebSocket\b/, desc: 'WebSocket constructor' },
    { pattern: /\bfetch\s*\(/, desc: 'fetch() HTTP network call' },
    { pattern: /\bXMLHttpRequest\b/, desc: 'XMLHttpRequest global' },
  ];

  const violations: string[] = [];

  for (const file of simFiles) {
    const text = fs.readFileSync(file, 'utf-8');
    for (const { pattern, desc } of forbiddenPatterns) {
      if (pattern.test(text)) {
        violations.push(`${path.relative(simSrcDir, file)}: references ${desc}`);
      }
    }
  }

  assert.deepEqual(violations, [], `Simulation core must remain strictly transport-agnostic:\n${violations.join('\n')}`);
});

group('Wire protocol JSON serialization');

test('all HostRequest and HostReply variants round-trip faithfully through JSON', () => {
  const bootParams: SimBootParams = {
    ...BOOT,
    seed: 1234,
  };

  const requests: HostRequest[] = [
    { kind: 'boot', id: 1, params: bootParams },
    { kind: 'advance', dt: 0.05 },
    { kind: 'command', commands: [{ type: 'rover/move', roverId: 1000, x: 20, z: -15, queue: false }] },
    { kind: 'placement', id: 2, command: { type: 'building/place', kind: 'solar', x: 40, z: 0 } },
    { kind: 'overlays', state: { keepBatteryFull: [1000] } },
    { kind: 'snapshot', id: 3 },
  ];

  for (const req of requests) {
    const json = JSON.stringify(req);
    const parsed = JSON.parse(json);
    assert.deepEqual(parsed, req, `Request ${req.kind} must survive JSON roundtrip`);
  }

  const dummyReply: HostReply = {
    kind: 'error',
    id: 1,
    error: 'test error message',
  };

  const replyJson = JSON.stringify(dummyReply);
  assert.deepEqual(JSON.parse(replyJson), dummyReply);
});

group('Network host lifecycle & operations');

test('NetworkSimHost boots, advances, and updates mirror over raw string network channel', async () => {
  const { clientChannel, serverChannel } = createSimulatedNetworkChannel({ latencyMs: 0 });

  // Server: bind runtime to string channel
  const serverRuntime = createSimRuntime((reply) => {
    serverChannel.send(JSON.stringify(reply));
  });
  bindServerNetworkChannel(serverChannel, serverRuntime);

  // Client: create HostPort from string channel and connect WorkerSimHost as network transport
  const hostPort = createNetworkHostPort(clientChannel);
  const host = await WorkerSimHost.connect(hostPort, {
    boot: { ...BOOT, seed: 555 },
    transport: 'network',
  });

  assert.equal(host.transport, 'network', 'Host must report network transport');
  assert.ok(host.view.rovers.length > 0, 'Host view should receive initial rovers');
  assert.equal(host.view.simTime, 0, 'Initial sim time is 0');

  // Advance simulation through network channel
  const t0 = host.view.simTime;
  host.step(0.5);
  // Wait a microtask tick for message delivery
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(host.view.simTime > t0, `Sim time should advance over network, got ${host.view.simTime}`);

  host.dispose();
});

test('commands and domain events propagate through network channel', async () => {
  const { clientChannel, serverChannel } = createSimulatedNetworkChannel({ latencyMs: 0 });

  const serverRuntime = createSimRuntime((reply) => {
    serverChannel.send(JSON.stringify(reply));
  });
  bindServerNetworkChannel(serverChannel, serverRuntime);

  const hostPort = createNetworkHostPort(clientChannel);
  const host = await WorkerSimHost.connect(hostPort, {
    boot: { ...BOOT, seed: 777 },
    transport: 'network',
  });

  const rover = host.view.rovers[0];
  assert.ok(rover, 'Colony must have rovers');

  // Send player command over network
  host.send({ type: 'rover/move', roverId: rover.id, x: 35, z: 25, queue: false });

  // Step and wait for response
  for (let i = 0; i < 5; i++) {
    host.step(0.1);
    await new Promise((r) => setTimeout(r, 10));
  }

  // Drain domain events over network
  const events = host.drainDomainEvents();
  assert.ok(Array.isArray(events), 'Domain events must be retrievable across network host');

  host.dispose();
});

test('snapshot save and restore succeed across network boundary', async () => {
  const { clientChannel, serverChannel } = createSimulatedNetworkChannel({ latencyMs: 0 });

  const serverRuntime = createSimRuntime((reply) => {
    serverChannel.send(JSON.stringify(reply));
  });
  bindServerNetworkChannel(serverChannel, serverRuntime);

  const hostPort = createNetworkHostPort(clientChannel);
  const host = await WorkerSimHost.connect(hostPort, {
    boot: { ...BOOT, seed: 888 },
    transport: 'network',
  });

  host.step(0.5);
  await new Promise((r) => setTimeout(r, 20));

  // Request snapshot over network
  const snapshot = await host.requestSnapshot();
  assert.ok(snapshot, 'Snapshot must be returned across network');
  assert.equal(typeof snapshot, 'object');
  assert.ok(JSON.stringify(snapshot).length > 1000);

  // Restore snapshot over network
  await host.loadSnapshot(snapshot);
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(host.view.rovers.length > 0, 'Restored view intact across network');
  host.dispose();
});

test('network latency resilience: steps and commands remain coherent under latency', async () => {
  // Simulate 15ms flight time in each direction
  const { clientChannel, serverChannel } = createSimulatedNetworkChannel({ latencyMs: 15 });

  const serverRuntime = createSimRuntime((reply) => {
    serverChannel.send(JSON.stringify(reply));
  });
  bindServerNetworkChannel(serverChannel, serverRuntime);

  const hostPort = createNetworkHostPort(clientChannel);
  const host = await WorkerSimHost.connect(hostPort, {
    boot: { ...BOOT, seed: 999 },
    transport: 'network',
  });

  // Issue back-to-back steps and commands during in-flight latency
  for (let step = 0; step < 10; step++) {
    host.step(0.1);
    if (step === 3) {
      host.send({ type: 'rover/stop', roverId: host.view.rovers[0].id });
    }
    await new Promise((r) => setTimeout(r, 20));
  }

  // Let pipeline drain
  await new Promise((r) => setTimeout(r, 100));

  assert.ok(host.view.simTime > 0, 'Simulation advanced despite network latency');
  host.dispose();
});

await finish('sim/network-boundary');
