// 轻量游戏音效。音频只在当前设备生成，音量设置保留在浏览器。
(() => {
'use strict';

const preference = 'ldc_sound';
const volume = 0.25;
let enabled = true;
try { enabled = localStorage.getItem(preference) !== 'off'; } catch (e) {}
let context, master, noise;

async function unlock() {
  if (!enabled) return;
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) return;
  try {
    if (!context || context.state === 'closed') {
      context = new Audio();
      master = context.createGain();
      master.gain.value = volume;
      master.connect(context.destination);
      noise = null;
    }
    if (context.state !== 'running') await context.resume();
  } catch (e) { /* 被浏览器限制时，保留静音的游戏体验。 */ }
}

function voice(source, when, length, amplitude, output = source) {
  const envelope = context.createGain();
  envelope.gain.setValueAtTime(0, when);
  envelope.gain.linearRampToValueAtTime(amplitude, when + 0.005);
  envelope.gain.exponentialRampToValueAtTime(0.001, when + length);
  output.connect(envelope);
  envelope.connect(master);
  source.onended = () => {
    source.disconnect();
    if (output !== source) output.disconnect();
    envelope.disconnect();
  };
  source.start(when);
  source.stop(when + length + 0.01);
}

function tone(when, frequency, length, amplitude, type = 'sine') {
  const oscillator = context.createOscillator();
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  voice(oscillator, when, length, amplitude);
}

function rattle(when, frequency, amplitude) {
  if (!noise) {
    noise = context.createBuffer(1, Math.ceil(context.sampleRate * 0.08), context.sampleRate);
    const samples = noise.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  }
  const source = context.createBufferSource();
  source.buffer = noise;
  const filter = context.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = frequency;
  filter.Q.value = 0.9;
  source.connect(filter);
  voice(source, when, 0.065, amplitude, filter);
}

const cues = {
  roll(at) {
    [0, 0.07, 0.14, 0.235, 0.36, 0.5].forEach((delay, i) => {
      rattle(at + delay, 1800 - i * 200, 0.28 - i * 0.022);
    });
    tone(at + 0.5, 167, 0.1, 0.15, 'triangle');
  },
  draw(at) {
    rattle(at, 2400, 0.16);
    tone(at + 0.025, 740, 0.08, 0.13, 'triangle');
    tone(at + 0.075, 988, 0.095, 0.1);
  },
  turn(at) {
    tone(at, 523, 0.095, 0.13, 'triangle');
    tone(at + 0.07, 659, 0.13, 0.11, 'triangle');
  },
  reveal(at) {
    tone(at, 392, 0.14, 0.13, 'triangle');
    tone(at + 0.065, 523, 0.16, 0.14, 'triangle');
    tone(at + 0.15, 659, 0.23, 0.13);
    tone(at + 0.15, 784, 0.23, 0.10);
  }
};

function play(name) {
  if (!enabled || document.hidden || context?.state !== 'running' || !cues[name]) return;
  cues[name](context.currentTime + 0.01);
}

function toggle() {
  enabled = !enabled;
  try { localStorage.setItem(preference, enabled ? 'on' : 'off'); } catch (e) {}
  if (master) master.gain.setValueAtTime(enabled ? volume : 0, context.currentTime);
  if (enabled) unlock().then(() => play('turn'));
}

document.addEventListener('click', unlock, { capture: true });
window.LdcSound = { play, toggle, get enabled() { return enabled; } };
})();
