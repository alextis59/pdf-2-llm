import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { stopChrome } from "../../../scripts/qa/browser-webgpu-preprocess.mjs";

class FakeChrome extends EventEmitter {
  constructor({ closeOnSignal = null } = {}) {
    super();
    this.closeOnSignal = closeOnSignal;
    this.exitCode = null;
    this.signals = [];
  }

  kill(signal) {
    this.signals.push(signal);
    if (signal === this.closeOnSignal) {
      this.exitCode = signal === "SIGTERM" ? 0 : null;
      queueMicrotask(() => this.emit("close", this.exitCode));
    }
    return true;
  }
}

test("stopChrome returns after graceful SIGTERM shutdown", async () => {
  const child = new FakeChrome({ closeOnSignal: "SIGTERM" });

  assert.equal(await stopChrome(child, { gracePeriodMs: 20, killWaitMs: 20 }), 0);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(child.listenerCount("close"), 0);
});

test("stopChrome escalates an unresponsive child to SIGKILL", async () => {
  const child = new FakeChrome({ closeOnSignal: "SIGKILL" });

  assert.equal(await stopChrome(child, { gracePeriodMs: 1, killWaitMs: 20 }), null);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.listenerCount("close"), 0);
});

test("stopChrome remains bounded when close never arrives after SIGKILL", async () => {
  const child = new FakeChrome();

  assert.equal(await stopChrome(child, { gracePeriodMs: 1, killWaitMs: 1 }), null);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.listenerCount("close"), 0);
});
