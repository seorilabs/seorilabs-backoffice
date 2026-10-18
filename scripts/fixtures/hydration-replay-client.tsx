import React, { startTransition, useEffect } from 'react';
import { hydrateRoot } from 'react-dom/client';
const root = document.getElementById('root')!;
const originalTarget = document.getElementById('target');
const originalChild = document.getElementById('child');
const errors: string[] = [];
let started = false;
const chunk = {
  status: 'pending', value: undefined as unknown, listeners: [] as ((value: unknown) => void)[],
  then(resolve: (value: unknown) => void) {
    if (this.status === 'fulfilled') { resolve(this.value); return; }
    this.listeners.push(resolve);
    if (!started) {
      started = true;
      queueMicrotask(() => {
        this.status = 'fulfilled'; this.value = { default: <section id="child">lazy child</section> };
        this.listeners.splice(0).forEach(listener => listener(this.value));
      });
    }
  },
};
const lazyNode = React.lazy(() => chunk as never);
function App() {
  useEffect(() => {
    setTimeout(() => {
      (window as unknown as { replayResult: unknown }).replayResult = {
        errors, sameTarget: document.getElementById('target') === originalTarget,
        sameChild: document.getElementById('child') === originalChild,
        text: root.textContent, reactVersion: React.version, chunkFulfilled: chunk.status === 'fulfilled',
        assertionPassed: errors.length === 0 && document.getElementById('target') === originalTarget && document.getElementById('child') === originalChild,
      };
    }, 30);
  }, []);
  return <div id="outer"><p id="before">before</p><div id="target">{lazyNode as unknown as React.ReactNode}</div><p id="after">after</p></div>;
}
function run() { startTransition(() => { hydrateRoot(root, <App />, { onRecoverableError: error => errors.push(String(error)) }); }); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true }); else run();
