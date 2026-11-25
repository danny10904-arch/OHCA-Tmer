'use strict';

const byId = id => document.getElementById(id);
const drugs = {
  epi: { name: 'Epinephrine (強心針)', seconds: 180 },
  amio: { name: 'Amiodarone (抗心律不整)', seconds: 240 },
};
const kinds = {
  custom: '-- 請選擇或自訂 --', shock: '電擊', noShock: '不建議電擊',
  epi: drugs.epi.name, amio: drugs.amio.name, bone: '骨針', airway: '插管',
  doubleShock: '雙重電擊', vitals: '生命徵象', iv: 'IO/IV 建立',
};
const empty = () => ({ events: [], start: null, arrival: null, rosc: false, timers: {} });
const storageKey = 'ohca-field-case-v1';
let state = empty();
try {
  const cached = JSON.parse(localStorage.getItem(storageKey));
  if (cached && Array.isArray(cached.events)) state = cached;
} catch {}
let timeline = false;
let audio;
let alarmTone;
let nextAlarmTone = 0;
const medAlert = byId('medAlert');
const clock = time => new Date(time).toLocaleTimeString('en-GB', { hour12: false });
const pad = n => String(n).padStart(2, '0');
const duration = n => pad(Math.floor(n / 60)) + ':' + pad(n % 60);
const events = () => [...state.events].sort((a, b) => b.time - a.time);
const count = kind => state.events.filter(event => event.kind === kind).length;

const vitalDisplay = {
  HR: ['心跳', ' /每分鐘'],
  SpO2: ['SpO2', ' %'],
  EtCO2: ['EtCO2', ' mmHg'],
  ECG: ['ECG/4-lead', ''],
  體溫: ['體溫', ' 度'],
};

function formatVitals(detail) {
  const parts = detail.split(/、(?=(?:SBP|DBP|MAP|HR|SpO2|EtCO2|ECG|體溫) )/);
  const fields = new Map();
  const lines = [];
  for (const part of parts) {
    const match = /^(SBP|DBP|MAP|HR|SpO2|EtCO2|ECG|體溫) (.+)$/s.exec(part);
    if (match) fields.set(match[1], match[2]);
    else if (part) lines.push(part);
  }
  const systolic = fields.get('SBP');
  const diastolic = fields.get('DBP');
  const map = fields.get('MAP')?.replace(/ mmHg$/, '');
  if (systolic && diastolic) {
    lines.push('血壓: ' + systolic + ' / ' + diastolic + ' mmHg' + (map ? ' (MAP: ' + map + ')' : ''));
  } else {
    if (systolic) lines.push('收縮壓: ' + systolic + ' mmHg');
    if (diastolic) lines.push('舒張壓: ' + diastolic + ' mmHg');
    if (map) lines.push('MAP: ' + map);
  }
  for (const [name, [label, unit]] of Object.entries(vitalDisplay)) {
    if (fields.has(name)) lines.push(label + ': ' + fields.get(name) + unit);
  }
  return lines.join('\n');
}

function eventDetail(event) {
  if (event.kind === 'airway') {
    return event.detail.replace(/^管徑 (ID [\d.]+)(?:、深度 ([\d.]+)(?:\s*cm)?)?$/, (_, size, depth) =>
      depth ? size + ', ' + depth + 'cm' : size);
  }
  if (event.kind === 'vitals') return formatVitals(event.detail);
  return event.detail;
}

function save() {
  try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch {}
}

function record(kind, detail = '', time = Date.now()) {
  state.start ??= time;
  state.start = Math.min(time, state.start);
  const event = { id: crypto.randomUUID?.() ?? String(Math.random()), kind, detail, time };
  state.events.push(event);
  if (Object.hasOwn(drugs, kind)) startDrugTimer(event);
  save();
  render();
}

function longPress(element, action, showProgress) {
  const holdDelay = 650;
  let timer, pressed;
  if (showProgress) element.style.setProperty('--hold-delay', holdDelay + 'ms');
  function stop() {
    clearTimeout(timer);
    if (showProgress) delete element.dataset.holding;
  }
  element.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.isPrimary === false) return;
    pressed = false;
    if (showProgress && !showProgress()) return;
    if (showProgress) element.dataset.holding = '';
    timer = setTimeout(() => {
      pressed = true;
      stop();
      action();
    }, holdDelay);
  });
  for (const name of ['pointerup', 'pointerleave', 'pointercancel']) element.addEventListener(name, stop);
  element.addEventListener('contextmenu', event => event.preventDefault());
  element.addEventListener('click', event => {
    if (pressed) { pressed = false; event.stopImmediatePropagation(); }
  }, true);
}

function ring() {
  if (audio?.state !== 'running' || audio.currentTime < nextAlarmTone) return;
  const oscillator = audio.createOscillator();
  const volume = audio.createGain();
  const time = audio.currentTime;
  oscillator.frequency.setValueAtTime(880, time);
  oscillator.frequency.setValueAtTime(660, time + 0.25);
  volume.gain.setValueAtTime(0.12, time);
  volume.gain.setValueAtTime(0, time + 0.17);
  volume.gain.setValueAtTime(0.12, time + 0.25);
  volume.gain.setValueAtTime(0, time + 0.42);
  oscillator.connect(volume).connect(audio.destination);
  oscillator.onended = () => { if (alarmTone === oscillator) alarmTone = undefined; };
  alarmTone = oscillator;
  oscillator.start(time);
  oscillator.stop(time + 0.43);
  nextAlarmTone = time + 1;
}

medAlert.addEventListener('cancel', event => event.preventDefault());
byId('medAlertAck').onclick = () => {
  alarmTone?.stop();
  alarmTone = undefined;
  nextAlarmTone = 0;
  medAlert.close();
  tick();
};

function unlockAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state !== 'running') audio.resume().catch(() => {});
  } catch {}
}

function remaining(kind, time) {
  const timer = state.timers[kind];
  return timer ? Math.max(0, Math.ceil((timer.end - time) / 1000)) : drugs[kind].seconds;
}

function startDrugTimer({ id, kind, time }) {
  if (state.rosc || (state.arrival && kind !== 'epi')) return;
  const end = time + drugs[kind].seconds * 1000;
  if (state.timers[kind]?.end >= end) return;
  unlockAudio();
  state.timers[kind] = { end, eventId: id, alerted: end <= Date.now() };
}

function tick() {
  const now = Date.now();
  byId('clock').textContent = clock(now);
  byId('elapsed').textContent = duration(state.start === null ? 0 : Math.max(0, Math.floor(((state.arrival ?? now) - state.start) / 1000)));
  for (const kind of Object.keys(drugs)) {
    const tile = byId(kind);
    const seconds = remaining(kind, now);
    const timer = state.timers[kind];
    const due = timer && seconds === 0;
    if (due && !timer.alerted && !state.rosc && (!state.arrival || kind === 'epi') && !medAlert.open) {
      byId('medAlertTitle').textContent = drugs[kind].name;
      medAlert.showModal();
      timer.alerted = true;
      save();
    }
    tile.querySelector('strong').textContent = duration(seconds);
    const hint = state.rosc ? 'ROSC 鎖定中' : due ? '時間到！' : timer ? '倒數中，長按重設' : '按一下開始倒數';
    tile.querySelector('.drug-count').textContent = count(kind) + ' 次';
    tile.querySelector('small').textContent = hint;
    tile.dataset.due = Boolean(due);
    tile.disabled = state.rosc;
  }
  if (medAlert.open) ring();
  const epiSeconds = remaining('epi', now);
  byId('remaining').textContent = duration(epiSeconds) + (epiSeconds === 0 ? '（請給藥）' : '');
  byId('expected').textContent = '預計時間: ' + (state.timers.epi ? clock(state.timers.epi.end) : '--:--:--');
}

function timerEvent(kind) {
  const timer = state.timers[kind];
  if (!timer) return undefined;
  return state.events.find(event => event.kind === kind && (timer.eventId
    ? event.id === timer.eventId
    : event.time + drugs[kind].seconds * 1000 === timer.end));
}

function remove(event) {
  if (!confirm('刪除這筆處置紀錄？')) return;
  removeEvent(event);
}

function removeEvent(event) {
  if (timerEvent(event.kind)?.id === event.id) delete state.timers[event.kind];
  state.events = state.events.filter(item => item.id !== event.id);
  save();
  render();
}

function renderEvents(container, ordered, editable) {
  container.replaceChildren();
  if (!ordered.length) {
    const row = document.createElement('li');
    row.className = 'empty-records';
    row.textContent = '尚未記錄任何處置';
    container.append(row);
  }
  for (const event of ordered) {
    const row = document.createElement('li');
    row.dataset.event = event.kind;
    const time = document.createElement('time');
    time.textContent = clock(event.time);
    const text = document.createElement('span');
    const label = event.kind === 'custom' ? '' : event.kind === 'status' ? '狀態變更' : kinds[event.kind];
    const detail = eventDetail(event);
    if (!editable && ['status', 'shock', 'noShock', 'doubleShock'].includes(event.kind)) {
      text.textContent = detail || label;
    } else if (label && detail) {
      const note = document.createElement('small');
      text.textContent = label;
      if (editable && ['shock', 'noShock', 'doubleShock'].includes(event.kind)) {
        const icon = document.createElement('span');
        icon.className = 'rhythm-mark';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = '⚡︎';
        text.append(icon);
      }
      note.textContent = detail;
      text.append(note);
    } else {
      text.textContent = [label, detail].filter(Boolean).join(' · ');
    }
    row.append(time, text);
    if (editable) {
      row.tabIndex = 0;
      row.setAttribute('aria-keyshortcuts', 'Delete');
      row.onkeydown = key => { if (key.key === 'Delete') remove(event); };
      longPress(row, () => remove(event));
    }
    container.append(row);
  }
}

function render() {
  const ordered = events();
  const rhythms = ordered.filter(event => ['shock', 'noShock', 'doubleShock'].includes(event.kind));
  const first = rhythms.at(-1);
  const airway = ordered.find(event => event.kind === 'airway');
  const summary = byId('summary');
  summary.replaceChildren();
  const values = {
    '最初心律': first?.detail && first.detail !== '不指定' ? first.detail + ' (電擊)' : '未知',
    '氣管管徑 / 深度': airway ? eventDetail(airway) || '無' : '無',
    '總電擊次數': count('shock') + count('doubleShock'),
    'Epi (強心針)': count('epi'), 'Amio (抗心律不整)': count('amio'),
  };
  for (const [label, value] of Object.entries(values)) {
    const cell = document.createElement('div');
    const term = document.createElement('dt');
    const result = document.createElement('dd');
    term.textContent = label;
    result.textContent = value;
    cell.append(term, result);
    summary.append(cell);
  }
  byId('rosc').textContent = state.rosc ? '再度 OHCA' : 'ROSC';
  byId('rosc').disabled = Boolean(state.arrival);
  byId('arrival').textContent = timeline ? '回到面板' : state.arrival ? '時序圖' : '到達醫院';
  byId('dashboard').hidden = timeline;
  byId('timeline').hidden = !timeline;
  document.querySelector('.actions').hidden = Boolean(state.arrival);
  byId('handover').hidden = !state.arrival;
  byId('iv').querySelector('small').textContent = count('iv') ? '已建立' : '點擊登錄建立時間';
  byId('iv').disabled = count('iv') > 0;
  byId('rhythm').querySelector('small').textContent = rhythms[0] ? '已記錄：' + (rhythms[0].detail || kinds[rhythms[0].kind]) : '點擊登錄分析結果';
  renderEvents(byId('events'), ordered, true);
  renderEvents(byId('timelineEvents'), ordered, false);
  tick();
}

for (const kind of Object.keys(drugs)) {
  const tile = byId(kind);
  longPress(tile, () => {
    const event = timerEvent(kind);
    if (event) {
      removeEvent(event);
      return;
    }
    delete state.timers[kind];
    save();
    tick();
  }, () => Boolean(state.timers[kind]) && !state.rosc && !state.arrival);
  tile.onclick = () => {
    const now = Date.now();
    if (state.rosc || state.arrival || state.timers[kind]?.end > now) return;
    record(kind, '第 ' + (count(kind) + 1) + ' 次', now);
  };
}
byId('iv').onclick = () => record('iv');

const rhythmDialog = byId('rhythmDialog');
function rhythmOptions(kind) {
  const choices = byId('options');
  choices.replaceChildren();
  const labels = kind === 'shock' ? ['VF', 'pVT'] : ['Asystole', 'PEA'];
  const options = kind
    ? [...labels.map(label => [label, () => { rhythmDialog.close(); record(kind, label); }]), ['返回上一步', () => rhythmOptions()]]
    : [['電擊', () => rhythmOptions('shock')], ['不建議電擊', () => rhythmOptions('noShock')], ['取消', () => rhythmDialog.close()]];
  for (const [label, action] of options) {
    const button = document.createElement('button');
    button.textContent = label;
    if (label === '電擊' || ['VF', 'pVT'].includes(label)) button.dataset.tone = 'shock';
    if (label === '不建議電擊' || ['Asystole', 'PEA'].includes(label)) button.dataset.tone = 'noShock';
    button.onclick = action;
    choices.append(button);
  }
}
byId('rhythm').onclick = () => { rhythmOptions(); rhythmDialog.showModal(); };

byId('rosc').onclick = () => {
  const message = state.rosc ? '確認患者再度 OHCA？' : '確認患者已達成 ROSC？\n\n【提醒量測生命徵象】\n確認後將記錄 ROSC 並停止藥物計時。';
  if (!confirm(message)) return;
  state.rosc = !state.rosc;
  state.timers = {};
  record('status', state.rosc ? '患者 ROSC' : '患者再度 OHCA');
};
byId('arrival').onclick = () => {
  if (state.arrival) {
    timeline = !timeline;
    render();
  } else if (confirm('確認已到達醫院？快速紀錄按鈕將被鎖定。')) {
    state.arrival = Date.now();
    delete state.timers.amio;
    record('status', '到達醫院', state.arrival);
  }
};
byId('reset').onclick = () => {
  if (!confirm('要開始新案件並清空目前紀錄嗎？')) return;
  state = empty();
  timeline = false;
  byId('manual').reset();
  setNow();
  renderFields();
  save();
  render();
};

const kindSelect = byId('kind');
for (const [kind, name] of Object.entries(kinds)) {
  if (kind !== 'iv') kindSelect.add(new Option(name, kind));
}
const timeParts = [byId('hour'), byId('minute'), byId('second')];
timeParts.forEach((field, index) => {
  for (let n = 0; n < (index ? 60 : 24); n++) field.add(new Option(pad(n)));
});
function setNow() {
  clock(Date.now()).split(':').forEach((value, index) => { timeParts[index].value = value; });
}
byId('now').onclick = setNow;
const shockOptions = ['VF', 'pVT', '不指定'];
const manualFields = {
  shock: [['心律', '心律', shockOptions]],
  noShock: [['心律', '心律', ['Asystole', 'PEA']]],
  doubleShock: [['心律', '心律', shockOptions]],
  airway: [['管徑', '管徑', ['ID 6.0', 'ID 6.5', 'ID 7.0', 'ID 7.5']], ['深度', '深度', 'number', '深度(cm)']],
};

function makeField(label, name, type = 'number', placeholder = '') {
  const field = document.createElement(Array.isArray(type) ? 'select' : 'input');
  field.name = name;
  field.setAttribute('aria-label', label);
  if (Array.isArray(type)) {
    for (const option of type) field.add(new Option(option));
  } else {
    field.type = type;
    field.placeholder = placeholder;
    if (type === 'number') { field.min = '0'; field.step = 'any'; }
  }
  return field;
}

function renderFields() {
  const fields = byId('fields');
  fields.replaceChildren();
  fields.oninput = null;
  const kind = kindSelect.value;
  if (kind === 'custom') {
    fields.append(makeField('自訂處置名稱', '處置', 'text', '輸入自訂處置名稱'));
  }
  for (const definition of manualFields[kind] ?? []) fields.append(makeField(...definition));
  if (kind === 'custom' || kind === 'vitals') {
    const vitals = document.createElement('div');
    vitals.className = 'vitals';
    const sbp = makeField('收縮壓', 'SBP', 'number', '收縮壓');
    const dbp = makeField('舒張壓', 'DBP', 'number', '舒張壓');
    const map = document.createElement('output');
    map.textContent = '(MAP: --)';
    const rows = [
      ['血壓', sbp, '/', dbp, 'mmHg', map],
      ['心跳', makeField('心跳', 'HR'), '/每分鐘'],
      ['SpO2', makeField('SpO2', 'SpO2'), '%'],
      ['EtCO2', makeField('EtCO2', 'EtCO2'), 'mmHg'],
      ['ECG', makeField('ECG', 'ECG', 'text', 'ECG/4-lead')],
      ['體溫', makeField('體溫', '體溫'), '度'],
    ];
    for (const [label, ...controls] of rows) {
      const row = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = label;
      row.append(title, ...controls);
      vitals.append(row);
    }
    fields.append(vitals);
    fields.oninput = () => {
      const value = sbp.value && dbp.value
        ? Math.round((Number(sbp.value) + 2 * Number(dbp.value)) / 3) : '--';
      map.value = '(MAP: ' + value + ')';
    };
  }
}
kindSelect.onchange = renderFields;
byId('manual').onsubmit = event => {
  event.preventDefault();
  let kind = kindSelect.value;
  const [h, m, s] = timeParts.map(field => Number(field.value));
  const now = new Date();
  const at = new Date(now);
  at.setHours(h, m, s, 0);
  if (at - now > 12 * 3600 * 1000) at.setDate(at.getDate() - 1);
  const form = new FormData(event.currentTarget);
  const custom = form.get('處置')?.trim();
  const entries = [...form].filter(([name, value]) => !['kind', '處置'].includes(name) && value.trim());
  const map = byId('fields').querySelector('output')?.textContent;
  if (map && map !== '(MAP: --)') entries.push(['MAP', map.slice(6, -1) + ' mmHg']);
  if (kind === 'custom' && !custom) kind = 'vitals';
  if (kind === 'vitals' && !entries.length) return;
  let detail = ['shock', 'noShock', 'doubleShock'].includes(kind)
    ? entries[0]?.[1] ?? ''
    : [custom, ...entries.map(([name, value]) => name + ' ' + value + (kind === 'airway' && name === '深度' ? ' cm' : ''))].filter(Boolean).join('、');
  detail = eventDetail({kind, detail});
  record(kind, detail, at.getTime());
};

setNow();
renderFields();
render();
document.addEventListener('pointerdown', unlockAudio, { once: true });
document.addEventListener('keydown', unlockAudio, { once: true });
setInterval(tick, 250);
