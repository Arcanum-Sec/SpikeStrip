'use strict';
function statusMessage() {
  const state = { ready: true };
  return state.ready ? 'Ready' : 'Waiting';
}
document.getElementById('status').textContent = statusMessage();
