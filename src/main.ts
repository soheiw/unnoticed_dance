import './style.css';
import type { FaceMesh, Results as FaceResults } from '@mediapipe/face_mesh';
import type { Pose, Results as PoseResults } from '@mediapipe/pose';
import {
  saveRecording,
  loadRecording,
  getAllRecordings,
  deleteRecording,
  type PoseFrame,
  type PoseLandmark,
  type StoredRecording,
} from './storage';

declare global {
  interface Window {
    Pose: typeof import('@mediapipe/pose').Pose;
    FaceMesh: typeof import('@mediapipe/face_mesh').FaceMesh;
  }
}

const root = document.getElementById('app');
const recordButton = document.getElementById('recordButton') as HTMLButtonElement | null;
const playOriginalButton = document.getElementById('playOriginalButton') as HTMLButtonElement | null;
const playButton = document.getElementById('playButton') as HTMLButtonElement | null;
const clearButton = document.getElementById('clearButton') as HTMLButtonElement | null;
const retryCameraButton = document.getElementById('retryCameraButton') as HTMLButtonElement | null;
const cameraSelect = document.getElementById('cameraSelect') as HTMLSelectElement | null;
const recordingSelect = document.getElementById('recordingSelect') as HTMLSelectElement | null;
const deleteRecordingButton = document.getElementById('deleteRecordingButton') as HTMLButtonElement | null;
const saveOriginalVideoCheckbox = document.getElementById('saveOriginalVideoCheckbox') as HTMLInputElement | null;
const ruleSetSelect = document.getElementById('ruleSetSelect') as HTMLSelectElement | null;
const saveRuleSetButton = document.getElementById('saveRuleSetButton') as HTMLButtonElement | null;
const deleteRuleSetButton = document.getElementById('deleteRuleSetButton') as HTMLButtonElement | null;
const bpmSlider = document.getElementById('bpmSlider') as HTMLInputElement | null;
const bpmInput = document.getElementById('bpmInput') as HTMLInputElement | null;
const panelRuleSelects = Array.from({ length: 5 }, (_, index) => (
  document.getElementById(`panelRuleSelect${index}`) as HTMLSelectElement | null
));
const statusElement = document.querySelector('.status') as HTMLElement | null;

if (
  !root ||
  !recordButton ||
  !playOriginalButton ||
  !playButton ||
  !clearButton ||
  !retryCameraButton ||
  !cameraSelect ||
  !recordingSelect ||
  !deleteRecordingButton ||
  !saveOriginalVideoCheckbox ||
  !ruleSetSelect ||
  !saveRuleSetButton ||
  !deleteRuleSetButton ||
  !bpmSlider ||
  !bpmInput ||
  panelRuleSelects.some((select) => !select) ||
  !statusElement
) {
  throw new Error('Required UI elements not found');
}

const video = document.createElement('video');
video.className = 'camera-preview';
video.autoplay = true;
video.muted = true;
video.playsInline = true;
root.appendChild(video);

const canvas = document.createElement('canvas');
canvas.className = 'dance-canvas';
root.appendChild(canvas);

const ctx = canvas.getContext('2d')!;

type VariationKind = 'wave' | 'upperPull' | 'centerRipple' | 'floatDrift' | 'gestureAccent' | 'rhythmLock';

interface VariationRule {
  id: string;
  name: string;
  kind: VariationKind;
  strength: number;
  timeShift: number;
}

interface StoredRuleSet {
  id: string;
  label: string;
  createdAt: string;
  rules: VariationRule[];
  panelRuleIds: string[];
  bpm: number;
  builtIn?: boolean;
}

const ruleSetStorageKey = 'unnoticed-dance-rule-sets-v1';
const cameraStorageKey = 'unnoticed-dance-camera-id-v1';
const builtInRuleSets: StoredRuleSet[] = [
  {
    id: 'default',
    label: 'Default transforms',
    createdAt: 'built-in',
    builtIn: true,
    bpm: 120,
    panelRuleIds: ['wave', 'upperPull', 'centerRipple', 'gestureAccent', 'rhythmLock'],
    rules: [
      { id: 'wave', name: 'Wave', kind: 'wave', strength: 1, timeShift: 0 },
      { id: 'upperPull', name: 'Upper pull', kind: 'upperPull', strength: 1, timeShift: -180 },
      { id: 'centerRipple', name: 'Center ripple', kind: 'centerRipple', strength: 1, timeShift: 0 },
      { id: 'floatDrift', name: 'Float drift', kind: 'floatDrift', strength: 1, timeShift: 220 },
      { id: 'gestureAccent', name: 'Gesture accent', kind: 'gestureAccent', strength: 1, timeShift: 0 },
      { id: 'rhythmLock', name: 'Rhythm lock', kind: 'rhythmLock', strength: 1, timeShift: 0 },
    ],
  },
];
const recordedFrames: PoseFrame[] = [];
let savedRecordings: StoredRecording[] = [];
let savedRuleSets: StoredRuleSet[] = [];
let activeRuleSetId = 'default';
let activeRecordingId = '';
type PlaybackMode = 'original' | 'dance';
let recording = false;
let playback = false;
let playbackMode: PlaybackMode = 'dance';
let playbackStart = 0;
let playbackDuration = 0;
let lastCaptureTime = 0;
const captureInterval = 120;
let currentLandmarks: PoseLandmark[] | null = null;
let currentFaceLandmarks: PoseLandmark[] = [];
let cameraStream: MediaStream | null = null;
let cameraFrameRequest = 0;
let cameraRunId = 0;
let processingCameraFrame = false;
let poseSolution: Pose | null = null;
let faceMeshSolution: FaceMesh | null = null;
let selectedCameraId = window.localStorage.getItem(cameraStorageKey) ?? '';
let cameraRetryCount = 0;
let cameraStarting = false;
let actionPeakCacheKey = '';
let actionPeakTime = 0;
let activePanelRuleIds = [...builtInRuleSets[0].panelRuleIds];
let activeBpm = builtInRuleSets[0].bpm;
let originalVideoRecorder: MediaRecorder | null = null;
let originalVideoChunks: BlobPart[] = [];
let originalVideoStartedAt = '';
let originalVideoCompletionStatus = '';

class CameraRequestTimeout extends Error {
  constructor() {
    super('Camera request timed out');
    this.name = 'CameraRequestTimeout';
  }
}

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

window.addEventListener('resize', resizeCanvas);

recordButton.addEventListener('click', () => {
  if (!recording) {
    startRecording();
  } else {
    stopRecording();
  }
});

playButton.addEventListener('click', () => {
  if (recordedFrames.length > 1) {
    startPlayback('dance');
  }
});

playOriginalButton.addEventListener('click', () => {
  if (recordedFrames.length > 1) {
    startPlayback('original');
  }
});

recordingSelect.addEventListener('change', () => {
  loadRecordingById(recordingSelect.value);
});

deleteRecordingButton.addEventListener('click', () => {
  deleteSelectedRecording();
});

ruleSetSelect.addEventListener('change', () => {
  activeRuleSetId = ruleSetSelect.value || 'default';
  applyRuleSet(getActiveRuleSet());
  renderRuleSetSelect();
  updateStatus(`loaded rules: ${getActiveRuleSet().label}`);
});

saveRuleSetButton.addEventListener('click', () => {
  saveCurrentRuleSet();
});

deleteRuleSetButton.addEventListener('click', () => {
  deleteSelectedRuleSet();
});

bpmSlider.addEventListener('input', () => {
  setActiveBpm(Number(bpmSlider.value));
});

bpmInput.addEventListener('change', () => {
  setActiveBpm(Number(bpmInput.value));
});

for (const [index, select] of panelRuleSelects.entries()) {
  select!.addEventListener('change', () => {
    activePanelRuleIds[index] = select!.value;
    syncActiveRuleSetFromControls();
    updateStatus(`panel ${index + 1}: ${getRuleById(select!.value)?.name ?? 'rule'}`);
  });
}

clearButton.addEventListener('click', () => {
  recordedFrames.length = 0;
  playback = false;
  activeRecordingId = '';
  playOriginalButton!.disabled = true;
  playButton!.disabled = true;
  recordButton!.textContent = 'Start Recording';
  recordingSelect!.value = '';
  updateStatus('motion cleared');
});

retryCameraButton.addEventListener('click', () => {
  initializeCamera(true);
});

cameraSelect.addEventListener('change', () => {
  selectedCameraId = cameraSelect.value;
  if (selectedCameraId) {
    window.localStorage.setItem(cameraStorageKey, selectedCameraId);
  } else {
    window.localStorage.removeItem(cameraStorageKey);
  }
  initializeCamera(true);
});

cameraSelect.addEventListener('pointerdown', () => {
  refreshCameraDevices();
});

function updateStatus(text: string) {
  statusElement!.textContent = `Status: ${text}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMilliseconds: number, onTimeout: () => Error): Promise<T> {
  let timeoutId = 0;
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(onTimeout()), timeoutMilliseconds);
  });

  return Promise.race([promise, timeout]).finally(() => {
    window.clearTimeout(timeoutId);
  });
}

function getUserMediaWithTimeout(constraints: MediaStreamConstraints) {
  if (!navigator.mediaDevices?.getUserMedia) {
    return Promise.reject(new Error('getUserMedia is not available'));
  }

  return withTimeout(
    navigator.mediaDevices.getUserMedia(constraints),
    12000,
    () => new CameraRequestTimeout(),
  );
}

function setPlaybackButtonsEnabled(enabled: boolean) {
  playOriginalButton!.disabled = !enabled;
  playButton!.disabled = !enabled;
}

async function loadSavedRecordings() {
  try {
    savedRecordings = await getAllRecordings();
  } catch (error) {
    console.warn('Failed to load saved recordings:', error);
    savedRecordings = [];
  }
  renderRecordingSelect();
}

function getAllRuleSets() {
  return [...builtInRuleSets, ...savedRuleSets];
}

function getActiveRuleSet() {
  return getAllRuleSets().find((ruleSet) => ruleSet.id === activeRuleSetId) ?? builtInRuleSets[0];
}

function normalizeRuleSet(ruleSet: StoredRuleSet): StoredRuleSet {
  const rules = ruleSet.rules.map((rule) => ({
    ...rule,
    id: rule.id ?? rule.kind,
  }));
  const panelRuleIds = (ruleSet.panelRuleIds?.length ? ruleSet.panelRuleIds : rules.slice(0, 5).map((rule) => rule.id)).slice(0, 5);

  while (panelRuleIds.length < 5) {
    panelRuleIds.push(rules[panelRuleIds.length % Math.max(1, rules.length)]?.id ?? 'wave');
  }

  return {
    ...ruleSet,
    bpm: Number.isFinite(ruleSet.bpm) ? ruleSet.bpm : 120,
    rules,
    panelRuleIds,
  };
}

function getRuleById(id: string) {
  return getActiveRuleSet().rules.find((rule) => rule.id === id) ?? getActiveRuleSet().rules[0];
}

function getActivePanelRules() {
  return activePanelRuleIds
    .map((id) => getRuleById(id))
    .filter((rule): rule is VariationRule => Boolean(rule));
}

function setActiveBpm(value: number) {
  activeBpm = clamp(Math.round(value || 120), 60, 180);
  bpmSlider!.value = `${activeBpm}`;
  bpmInput!.value = `${activeBpm}`;
  syncActiveRuleSetFromControls();
}

function syncActiveRuleSetFromControls() {
  const active = getActiveRuleSet();
  if (active.builtIn) return;

  active.bpm = activeBpm;
  active.panelRuleIds = [...activePanelRuleIds];
  persistSavedRuleSets();
}

function applyRuleSet(ruleSet: StoredRuleSet) {
  const normalized = normalizeRuleSet(ruleSet);
  activeBpm = normalized.bpm;
  activePanelRuleIds = [...normalized.panelRuleIds];
  bpmSlider!.value = `${activeBpm}`;
  bpmInput!.value = `${activeBpm}`;
  renderPanelRuleSelects();
}

function loadSavedRuleSets() {
  try {
    const raw = window.localStorage.getItem(ruleSetStorageKey);
    savedRuleSets = raw ? (JSON.parse(raw) as StoredRuleSet[]).map(normalizeRuleSet) : [];
  } catch (error) {
    console.warn('Failed to load saved rule sets:', error);
    savedRuleSets = [];
  }
  renderRuleSetSelect();
}

function persistSavedRuleSets() {
  window.localStorage.setItem(ruleSetStorageKey, JSON.stringify(savedRuleSets));
}

function renderRuleSetSelect() {
  ruleSetSelect!.innerHTML = '';

  for (const ruleSet of getAllRuleSets()) {
    const option = document.createElement('option');
    option.value = ruleSet.id;
    option.textContent = ruleSet.builtIn ? `${ruleSet.label} (built-in)` : ruleSet.label;
    ruleSetSelect!.appendChild(option);
  }

  ruleSetSelect!.value = activeRuleSetId;
  deleteRuleSetButton!.disabled = getActiveRuleSet().builtIn === true;
  renderPanelRuleSelects();
}

function renderPanelRuleSelects() {
  const active = getActiveRuleSet();

  for (const [index, select] of panelRuleSelects.entries()) {
    select!.innerHTML = '';
    for (const rule of active.rules) {
      const option = document.createElement('option');
      option.value = rule.id;
      option.textContent = rule.name;
      select!.appendChild(option);
    }
    select!.value = activePanelRuleIds[index] ?? active.rules[0]?.id ?? '';
  }
}

function saveCurrentRuleSet() {
  const source = getActiveRuleSet();
  const createdAt = new Date();
  const ruleSet: StoredRuleSet = {
    id: `${createdAt.getTime()}`,
    label: `${source.label} copy ${createdAt.toLocaleTimeString()}`,
    createdAt: createdAt.toISOString(),
    rules: source.rules.map((rule) => ({ ...rule })),
    panelRuleIds: [...activePanelRuleIds],
    bpm: activeBpm,
  };

  savedRuleSets = [ruleSet, ...savedRuleSets].slice(0, 20);
  activeRuleSetId = ruleSet.id;
  persistSavedRuleSets();
  applyRuleSet(ruleSet);
  renderRuleSetSelect();
  updateStatus(`saved rules: ${ruleSet.label}`);
}

function deleteSelectedRuleSet() {
  const active = getActiveRuleSet();
  if (active.builtIn) return;

  savedRuleSets = savedRuleSets.filter((ruleSet) => ruleSet.id !== activeRuleSetId);
  activeRuleSetId = 'default';
  applyRuleSet(builtInRuleSets[0]);
  persistSavedRuleSets();
  renderRuleSetSelect();
  updateStatus('deleted rule set');
}

function renderRecordingSelect() {
  recordingSelect!.innerHTML = '';

  if (savedRecordings.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No saved recordings';
    recordingSelect!.appendChild(option);
    recordingSelect!.disabled = true;
    deleteRecordingButton!.disabled = true;
    return;
  }

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select saved motion';
  recordingSelect!.appendChild(placeholder);

  for (const recording of savedRecordings) {
    const option = document.createElement('option');
    option.value = recording.id;
    option.textContent = `${recording.label} (${recording.frames.length} frames)`;
    recordingSelect!.appendChild(option);
  }

  recordingSelect!.disabled = false;
  recordingSelect!.value = activeRecordingId;
  deleteRecordingButton!.disabled = !activeRecordingId;
}

function copyFrames(frames: PoseFrame[]) {
  return frames.map((frame) => ({
    t: frame.t,
    landmarks: frame.landmarks.map((landmark) => ({ ...landmark })),
    faceLandmarks: frame.faceLandmarks.map((landmark) => ({ ...landmark })),
  }));
}

function normalizeFrames(frames: PoseFrame[]) {
  return frames.map((frame) => ({
    t: frame.t,
    landmarks: frame.landmarks.map((landmark) => ({
      x: landmark.x,
      y: landmark.y,
      z: Number.isFinite(landmark.z) ? landmark.z : 0,
      visibility: landmark.visibility ?? 0,
    })),
    faceLandmarks: (frame.faceLandmarks ?? []).map((landmark) => ({
      x: landmark.x,
      y: landmark.y,
      z: Number.isFinite(landmark.z) ? landmark.z : 0,
      visibility: landmark.visibility ?? 1,
    })),
  }));
}

function activateRecording(recording: StoredRecording, statusText: string) {
  recordedFrames.length = 0;
  recordedFrames.push(...normalizeFrames(recording.frames));
  activeRecordingId = recording.id;
  playback = false;
  playbackDuration = recording.duration;
  setPlaybackButtonsEnabled(recordedFrames.length > 1);
  renderRecordingSelect();
  updateStatus(statusText);
}

async function saveCurrentRecording(): Promise<{ recording: StoredRecording; persisted: boolean } | null> {
  if (recordedFrames.length < 4 || playbackDuration <= 0) {
    return null;
  }

  const createdAt = new Date();
  const recording: StoredRecording = {
    id: `${createdAt.getTime()}`,
    label: `Motion ${createdAt.toLocaleString()}`,
    createdAt: createdAt.toISOString(),
    duration: playbackDuration,
    frames: copyFrames(recordedFrames),
  };

  try {
    await saveRecording(recording);
    savedRecordings = [recording, ...savedRecordings];
    return { recording, persisted: true };
  } catch (error) {
    console.warn('Could not persist recording:', error);
    return { recording, persisted: false };
  }
}

async function loadRecordingById(id: string) {
  if (!id) {
    activeRecordingId = '';
    deleteRecordingButton!.disabled = true;
    return;
  }

  try {
    const recording = await loadRecording(id);
    if (!recording) {
      updateStatus('saved motion not found');
      renderRecordingSelect();
      return;
    }

    recording.frames = normalizeFrames(recording.frames);
    activateRecording(recording, `loaded ${recording.label}`);
  } catch (error) {
    console.warn('Failed to load recording:', error);
    updateStatus('failed to load saved motion');
  }
}

async function deleteSelectedRecording() {
  if (!activeRecordingId) return;

  const deleted = savedRecordings.find((item) => item.id === activeRecordingId);
  try {
    await deleteRecording(activeRecordingId);
  } catch (error) {
    console.warn('Failed to delete recording:', error);
    updateStatus('failed to delete saved motion');
    return;
  }

  savedRecordings = savedRecordings.filter((item) => item.id !== activeRecordingId);
  activeRecordingId = '';
  recordedFrames.length = 0;
  playback = false;
  playbackDuration = 0;
  setPlaybackButtonsEnabled(false);
  renderRecordingSelect();
  updateStatus(deleted ? `deleted ${deleted.label}` : 'saved motion deleted');
}

async function refreshCameraDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;

  try {
    const devices = (await navigator.mediaDevices.enumerateDevices())
      .filter((device) => device.kind === 'videoinput');

    cameraSelect!.innerHTML = '';
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Default camera';
    cameraSelect!.appendChild(defaultOption);

    for (const [index, device] of devices.entries()) {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Camera ${index + 1}`;
      cameraSelect!.appendChild(option);
    }

    if (selectedCameraId && !devices.some((device) => device.deviceId === selectedCameraId)) {
      selectedCameraId = '';
      window.localStorage.removeItem(cameraStorageKey);
    }

    cameraSelect!.value = selectedCameraId;
    cameraSelect!.disabled = devices.length === 0;
    if (devices.length === 0) updateStatus('no camera devices found');
  } catch (error) {
    console.warn('Could not enumerate cameras:', error);
  }
}

function stopCameraStream() {
  cameraRunId += 1;
  if (cameraFrameRequest) {
    cancelAnimationFrame(cameraFrameRequest);
    cameraFrameRequest = 0;
  }
  if (cameraStream) {
    for (const track of cameraStream.getTracks()) track.stop();
    cameraStream = null;
  }
  video.srcObject = null;
  processingCameraFrame = false;
}

function createPoseSolution() {
  const pose = new window.Pose({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${file}`,
  });
  pose.setOptions({
    modelComplexity: 1,
    smoothLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  pose.onResults(handlePoseResults);
  return pose;
}

function createFaceMeshSolution() {
  const faceMesh = new window.FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/${file}`,
  });
  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  faceMesh.onResults(handleFaceResults);
  return faceMesh;
}

function startCameraFrameLoop(runId: number) {
  const tick = async () => {
    if (runId !== cameraRunId) return;

    if (video.readyState >= 2 && poseSolution && faceMeshSolution && !processingCameraFrame) {
      processingCameraFrame = true;
      try {
        await poseSolution.send({ image: video });
      } catch (error) {
        currentLandmarks = null;
        console.warn('Pose frame failed:', error);
      }

      try {
        await faceMeshSolution.send({ image: video });
      } catch (error) {
        currentFaceLandmarks = [];
        console.warn('FaceMesh frame failed:', error);
      } finally {
        processingCameraFrame = false;
      }
    }

    cameraFrameRequest = requestAnimationFrame(tick);
  };

  cameraFrameRequest = requestAnimationFrame(tick);
}

async function initializeCamera(force = false) {
  if (cameraStarting && !force) return;
  cameraStarting = true;
  updateStatus('requesting camera permission');
  cameraSelect!.disabled = true;
  retryCameraButton!.disabled = false;
  retryCameraButton!.textContent = 'Enable Camera';

  if (force) {
    cameraRetryCount = 0;
  }

  stopCameraStream();
  poseSolution = createPoseSolution();
  faceMeshSolution = createFaceMeshSolution();

  const videoConstraint: MediaTrackConstraints = {
    width: { ideal: 640 },
    height: { ideal: 480 },
  };
  if (selectedCameraId) videoConstraint.deviceId = { exact: selectedCameraId };

  try {
    try {
      cameraStream = await getUserMediaWithTimeout({
        video: videoConstraint,
        audio: false,
      });
    } catch (error) {
      if (!selectedCameraId || !(error instanceof DOMException) || error.name !== 'OverconstrainedError') {
        throw error;
      }

      selectedCameraId = '';
      window.localStorage.removeItem(cameraStorageKey);
      cameraStream = await getUserMediaWithTimeout({
        video: { width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
    }

    video.srcObject = cameraStream;
    video.play().catch((error) => {
      console.warn('Video preview playback failed:', error);
    });

    const activeTrack = cameraStream.getVideoTracks()[0];
    const activeDeviceId = activeTrack?.getSettings().deviceId;
    if (!selectedCameraId && activeDeviceId) selectedCameraId = activeDeviceId;
    refreshCameraDevices();

    const runId = cameraRunId;
    startCameraFrameLoop(runId);
    cameraStarting = false;
    cameraRetryCount = 0;
    retryCameraButton!.textContent = 'Retry Camera';
    updateStatus('camera ready, move into view');
  } catch (error) {
    cameraStarting = false;
    cameraRetryCount += 1;
    cameraSelect!.disabled = false;
    retryCameraButton!.textContent = 'Enable Camera';

    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      updateStatus('camera permission blocked');
    } else if (error instanceof DOMException && error.name === 'NotFoundError') {
      updateStatus('no camera devices found');
    } else if (error instanceof DOMException && error.name === 'NotReadableError') {
      updateStatus('camera is busy in another app');
    } else if (error instanceof CameraRequestTimeout) {
      updateStatus('camera permission prompt timed out; check browser camera icon');
    } else if (cameraRetryCount <= 2) {
      window.setTimeout(() => initializeCamera(true), 800);
      updateStatus('camera busy, retrying…');
    } else {
      updateStatus('camera access required — click retry');
    }

    console.warn('Camera startup failed:', error);
  }
}

function handleFaceResults(results: FaceResults) {
  currentFaceLandmarks = (results.multiFaceLandmarks?.[0] ?? []).map((landmark) => ({
    x: landmark.x,
    y: landmark.y,
    z: landmark.z ?? 0,
    visibility: 1,
  }));
}

function handlePoseResults(results: PoseResults) {
  if (!results.poseLandmarks) {
    currentLandmarks = null;
    return;
  }

  currentLandmarks = results.poseLandmarks.map((landmark) => ({
    x: landmark.x,
    y: landmark.y,
    z: landmark.z ?? 0,
    visibility: landmark.visibility ?? 0,
  }));

  if (recording) {
    capturePose(performance.now());
  }
}

function capturePose(time: number) {
  if (!recording || !currentLandmarks) return;
  if (time - lastCaptureTime < captureInterval) return;

  recordedFrames.push({
    t: time,
    landmarks: currentLandmarks.map((landmark) => ({ ...landmark })),
    faceLandmarks: currentFaceLandmarks.map((landmark) => ({ ...landmark })),
  });
  lastCaptureTime = time;
}

function getOriginalVideoMimeType() {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? '';
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function startOriginalVideoRecording() {
  if (!saveOriginalVideoCheckbox!.checked) return false;
  if (!('MediaRecorder' in window)) {
    updateStatus('original video recording is not supported in this browser');
    return false;
  }

  const stream = video.srcObject;
  if (!(stream instanceof MediaStream)) {
    updateStatus('camera stream not ready for original video');
    return false;
  }

  originalVideoChunks = [];
  originalVideoCompletionStatus = '';
  originalVideoStartedAt = new Date().toISOString().replace(/[:.]/g, '-');

  try {
    const mimeType = getOriginalVideoMimeType();
    originalVideoRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch (error) {
    originalVideoRecorder = null;
    updateStatus('could not start original video recording');
    console.warn('Original video recording failed:', error);
    return false;
  }

  originalVideoRecorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) originalVideoChunks.push(event.data);
  });

  originalVideoRecorder.addEventListener('stop', () => {
    if (originalVideoChunks.length > 0) {
      const blob = new Blob(originalVideoChunks, {
        type: originalVideoRecorder?.mimeType || 'video/webm',
      });
      downloadBlob(blob, `unnoticed-dance-original-${originalVideoStartedAt}.webm`);
    }
    originalVideoChunks = [];
    if (originalVideoCompletionStatus) updateStatus(originalVideoCompletionStatus);
  });

  originalVideoRecorder.start(1000);
  return true;
}

function stopOriginalVideoRecording(completionStatus = '') {
  if (!originalVideoRecorder) return;
  originalVideoCompletionStatus = completionStatus;
  if (originalVideoRecorder.state !== 'inactive') {
    originalVideoRecorder.stop();
  }
  originalVideoRecorder = null;
}

function startRecording() {
  recording = true;
  playback = false;
  activeRecordingId = '';
  recordedFrames.length = 0;
  playbackDuration = 0;
  lastCaptureTime = performance.now();
  recordButton!.textContent = 'Stop Recording';
  recordingSelect!.value = '';
  setPlaybackButtonsEnabled(false);
  const originalVideoStarted = startOriginalVideoRecording();
  if (originalVideoStarted) {
    updateStatus('recording body motion and original video');
  } else if (!saveOriginalVideoCheckbox!.checked) {
    updateStatus('recording body motion');
  }
}

async function stopRecording() {
  recording = false;
  recordButton!.textContent = 'Start Recording';

  if (recordedFrames.length < 4) {
    stopOriginalVideoRecording('saved original video; too little motion data');
    updateStatus('too little motion, try again');
    return;
  }

  playbackDuration = recordedFrames[recordedFrames.length - 1].t - recordedFrames[0].t;
  if (playbackDuration <= 0) {
    stopOriginalVideoRecording('saved original video; motion data was unstable');
    updateStatus('recording unstable, try again');
    return;
  }

  activeRecordingId = '';
  recordingSelect!.value = '';
  const saveResult = await saveCurrentRecording();

  if (!saveResult) {
    stopOriginalVideoRecording('saved original video; motion data could not be saved');
    setPlaybackButtonsEnabled(false);
    updateStatus('recording could not be saved');
    return;
  }

  const { recording: savedRecording, persisted } = saveResult;
  activateRecording(
    savedRecording,
    persisted ? `saved ${savedRecording.label}` : `${savedRecording.label} ready to play (storage full, not saved)`,
  );
  stopOriginalVideoRecording(
    persisted ? 'saved motion and original video' : 'storage full; recording not saved to library',
  );
}

function startPlayback(mode: PlaybackMode) {
  playback = true;
  playbackMode = mode;
  playbackStart = performance.now();
  recording = false;
  recordButton!.textContent = 'Start Recording';
  updateStatus(mode === 'original' ? 'playing original motion' : 'playing dance');
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(value: number) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function getActionPeakTime() {
  const cacheKey = `${activeRecordingId}:${recordedFrames.length}:${playbackDuration}`;
  if (cacheKey === actionPeakCacheKey) return actionPeakTime;

  actionPeakCacheKey = cacheKey;
  actionPeakTime = playbackDuration * 0.5;

  if (recordedFrames.length < 3) return actionPeakTime;

  const keyIndexes = [13, 14, 15, 16, 25, 26, 27, 28];
  let bestEnergy = -Infinity;

  for (let i = 1; i < recordedFrames.length; i += 1) {
    const previous = recordedFrames[i - 1];
    const current = recordedFrames[i];
    const dt = Math.max(1, current.t - previous.t);
    let energy = 0;

    for (const index of keyIndexes) {
      const a = previous.landmarks[index];
      const b = current.landmarks[index];
      if (!a || !b || a.visibility < 0.2 || b.visibility < 0.2) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = (b.z ?? 0) - (a.z ?? 0);
      energy += Math.sqrt(dx * dx + dy * dy + dz * dz) / dt;
    }

    if (energy > bestEnergy) {
      bestEnergy = energy;
      actionPeakTime = current.t - recordedFrames[0].t;
    }
  }

  return actionPeakTime;
}

function gestureAccentTime(loopTime: number) {
  const peak = getActionPeakTime();
  const windowSize = Math.max(240, playbackDuration * 0.32);
  const halfWindow = windowSize / 2;
  let relative = loopTime - peak;

  if (relative > playbackDuration / 2) relative -= playbackDuration;
  if (relative < -playbackDuration / 2) relative += playbackDuration;
  if (Math.abs(relative) > halfWindow) return loopTime;

  const local = (relative + halfWindow) / windowSize;
  const eased = smoothstep(local);
  const accentedRelative = (eased - 0.5) * windowSize;
  return (peak + accentedRelative + playbackDuration) % playbackDuration;
}

function rhythmLockTime(loopTime: number) {
  const beatMs = 60000 / activeBpm;
  const beatIndex = Math.floor(loopTime / beatMs);
  const beatStart = beatIndex * beatMs;
  const phase = (loopTime - beatStart) / beatMs;
  const snappedPhase = smoothstep(phase);
  const easedTime = beatStart + snappedPhase * beatMs;
  const nearestBeat = Math.round(loopTime / beatMs) * beatMs;
  const beatPull = 0.32;
  return ((easedTime * (1 - beatPull) + nearestBeat * beatPull) + playbackDuration) % playbackDuration;
}

function transformPoseForDance(baseFrame: PoseFrame, elapsedMilliseconds: number, variationIndex: number, ruleKind: VariationKind, strength: number): PoseLandmark[] {
  const phase = elapsedMilliseconds / 420;

  return baseFrame.landmarks.map((landmark, index) => {
    const isHead = index <= 10;
    const isUpperBody = index >= 11 && index <= 16;
    const isLowerBody = index >= 23;
    let x = landmark.x;
    let y = landmark.y;
    let z = landmark.z;

    if (isHead) {
      return { x, y, z, visibility: landmark.visibility };
    }

    if (ruleKind === 'wave') {
      const sway = Math.sin(phase + index * 0.32) * (isUpperBody ? 0.034 : 0.022);
      const twist = Math.cos(phase * 1.24 + index * 0.2) * (isLowerBody ? 0.018 : 0.01);
      const lift = Math.sin(phase * 0.72 + index * 0.14) * 0.016;
      const offset = (index % 3 === 0 ? 0.006 : index % 3 === 1 ? -0.004 : 0.002);
      x += (sway + offset) * strength;
      y += (twist + lift) * strength;
      z += Math.sin(phase * 0.9 + index * 0.17) * 0.025 * strength;
    } else if (ruleKind === 'upperPull') {
      const shoulderPull = isUpperBody ? Math.sin(phase * 0.86 + index * 0.18) * 0.044 : 0;
      const lowerAnchor = isLowerBody ? Math.cos(phase * 0.62 + index * 0.25) * 0.012 : 0;
      x += (shoulderPull + lowerAnchor) * strength;
      y += Math.sin(phase * 1.08 + index * 0.11) * (isUpperBody ? 0.012 : 0.024) * strength;
      if (index === 15 || index === 16) z -= 0.18 * strength;
      if (isUpperBody) z -= Math.sin(phase * 0.7) * 0.035 * strength;
    } else if (ruleKind === 'centerRipple') {
      const centerPull = (0.5 - landmark.x) * 0.12;
      const ripple = Math.sin(phase * 1.35 + landmark.y * 10 + index * 0.21) * 0.02;
      x += (centerPull + ripple) * strength;
      y += Math.cos(phase * 0.92 + index * 0.3) * 0.018 * strength;
      z += Math.sin(phase * 1.2 + landmark.x * 8) * 0.04 * strength;
    } else if (ruleKind === 'floatDrift') {
      const float = Math.sin(phase * 0.7 + index * 0.16) * 0.032;
      const drift = Math.cos(phase * 0.48 + index * 0.19) * 0.024;
      x += (drift + (isLowerBody ? -0.01 : 0.012)) * strength;
      y += (float - (isUpperBody ? 0.018 : 0.006)) * strength;
      z += (isUpperBody ? -0.05 : 0.03) * strength;
    } else if (ruleKind === 'gestureAccent') {
      const accent = Math.sin(phase * 1.7) * 0.012;
      const isExpressiveJoint = [13, 14, 15, 16, 27, 28].includes(index);
      x += (isExpressiveJoint ? accent * (index % 2 === 0 ? 1 : -1) : accent * 0.25) * strength;
      y += (isExpressiveJoint ? Math.cos(phase * 1.3 + index) * 0.018 : 0) * strength;
      z += (isExpressiveJoint ? -0.04 : 0.01) * strength;
    } else {
      const beatMs = 60000 / activeBpm;
      const beatPhase = (elapsedMilliseconds % beatMs) / beatMs;
      const pulse = Math.sin(beatPhase * Math.PI);
      const isArm = [13, 14, 15, 16].includes(index);
      const isFoot = [27, 28, 29, 30].includes(index);
      x += Math.sin(phase + index * 0.2) * 0.01 * strength;
      y += (isArm ? -pulse * 0.026 : isFoot ? pulse * 0.014 : pulse * 0.006) * strength;
      z += (isArm ? -pulse * 0.035 : 0) * strength;
    }

    return { x: clamp(x, 0, 1), y: clamp(y, 0, 1), z, visibility: landmark.visibility };
  });
}

function transformFaceForDance(baseFrame: PoseFrame, transformedLandmarks: PoseLandmark[]): PoseLandmark[] {
  if (baseFrame.faceLandmarks.length === 0) return [];

  const sourceNose = baseFrame.landmarks[0];
  const transformedNose = transformedLandmarks[0];
  if (!sourceNose || !transformedNose) return baseFrame.faceLandmarks.map((landmark) => ({ ...landmark }));

  const dx = transformedNose.x - sourceNose.x;
  const dy = transformedNose.y - sourceNose.y;
  const dz = transformedNose.z - sourceNose.z;

  return baseFrame.faceLandmarks.map((landmark) => ({
    x: clamp(landmark.x + dx, 0, 1),
    y: clamp(landmark.y + dy, 0, 1),
    z: landmark.z + dz,
    visibility: landmark.visibility,
  }));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function interpolateFrame(from: PoseFrame, to: PoseFrame, t: number): PoseFrame {
  const faceCount = Math.min(from.faceLandmarks.length, to.faceLandmarks.length);
  return {
    t: lerp(from.t, to.t, t),
    landmarks: from.landmarks.map((landmark, index) => {
      const next = to.landmarks[index];
      return {
        x: lerp(landmark.x, next.x, t),
        y: lerp(landmark.y, next.y, t),
        z: lerp(landmark.z ?? 0, next.z ?? 0, t),
        visibility: lerp(landmark.visibility, next.visibility, t),
      };
    }),
    faceLandmarks: Array.from({ length: faceCount }, (_, index) => {
      const landmark = from.faceLandmarks[index];
      const next = to.faceLandmarks[index];
      return {
        x: lerp(landmark.x, next.x, t),
        y: lerp(landmark.y, next.y, t),
        z: lerp(landmark.z ?? 0, next.z ?? 0, t),
        visibility: lerp(landmark.visibility, next.visibility, t),
      };
    }),
  };
}

function sampleFrameAt(timeOffset: number): PoseFrame | null {
  if (recordedFrames.length === 0) return null;

  const startTime = recordedFrames[0].t;
  const target = startTime + timeOffset;
  if (target <= startTime) return recordedFrames[0];

  const end = recordedFrames[recordedFrames.length - 1];
  if (target >= end.t) return end;

  for (let i = 1; i < recordedFrames.length; i += 1) {
    const previous = recordedFrames[i - 1];
    const next = recordedFrames[i];
    if (target <= next.t) {
      const local = (target - previous.t) / (next.t - previous.t);
      return interpolateFrame(previous, next, local);
    }
  }

  return end;
}

function toCanvas(landmark: PoseLandmark) {
  return {
    x: landmark.x * canvas.width,
    y: landmark.y * canvas.height,
    z: landmark.z,
    visibility: landmark.visibility,
  };
}

function depthReference(landmarks: PoseLandmark[]) {
  const torsoIndexes = [11, 12, 23, 24];
  const values = torsoIndexes
    .map((index) => landmarks[index]?.z)
    .filter((value): value is number => Number.isFinite(value));

  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function depthAmount(landmark: PoseLandmark, referenceZ: number) {
  // MediaPipe's z is relative: smaller values are usually closer to the camera.
  return clamp((referenceZ - (landmark.z ?? referenceZ)) * 2.8, -0.55, 0.9);
}

function depthColor(color: string, amount: number, alpha: number) {
  const brightness = clamp(0.78 + amount * 0.2, 0.48, 1);
  if (color.includes('92, 214, 255')) {
    return `rgba(${Math.round(92 * brightness)}, ${Math.round(214 * brightness)}, ${Math.round(255 * brightness)}, ${alpha})`;
  }
  const value = Math.round(255 * brightness);
  return `rgba(${value}, ${value}, ${value}, ${alpha})`;
}

const skeletonConnections: Array<[number, number]> = [
  [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 12], [23, 24], [23, 25], [24, 26],
  [25, 27], [26, 28], [27, 29], [28, 30],
  [11, 23], [12, 24],
];

function drawFaceGlyph(
  landmarks: PoseLandmark[],
  faceLandmarks: PoseLandmark[],
  toPoint: (landmark: PoseLandmark) => PoseLandmark,
  alpha: number,
  stroke: string,
  scale: number,
) {
  if (faceLandmarks.length > 0) {
    const drawPath = (indexes: number[], close = false) => {
      ctx.beginPath();
      for (const [position, index] of indexes.entries()) {
        const landmark = faceLandmarks[index];
        if (!landmark) continue;
        const point = toPoint(landmark);
        if (position === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      }
      if (close) ctx.closePath();
      ctx.stroke();
    };

    const faceOval = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
    const leftEye = [33, 160, 158, 133, 153, 144];
    const rightEye = [362, 385, 387, 263, 373, 380];
    const mouth = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = depthColor(stroke, 0, alpha);
    ctx.fillStyle = 'rgba(8, 8, 16, 0.36)';
    ctx.lineWidth = Math.max(1.2, scale * 0.006);
    ctx.beginPath();
    for (const [position, index] of faceOval.entries()) {
      const landmark = faceLandmarks[index];
      if (!landmark) continue;
      const point = toPoint(landmark);
      if (position === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.lineWidth = Math.max(1, scale * 0.0045);
    drawPath(leftEye, true);
    drawPath(rightEye, true);
    drawPath(mouth, false);
    ctx.restore();
    return;
  }

  const nose = landmarks[0];
  if (!nose || nose.visibility < 0.2) return;

  const faceCenter = toPoint(nose);
  const leftEye = landmarks[2]?.visibility >= 0.2 ? toPoint(landmarks[2]) : null;
  const rightEye = landmarks[5]?.visibility >= 0.2 ? toPoint(landmarks[5]) : null;
  const leftMouth = landmarks[9]?.visibility >= 0.2 ? toPoint(landmarks[9]) : null;
  const rightMouth = landmarks[10]?.visibility >= 0.2 ? toPoint(landmarks[10]) : null;
  const leftEar = landmarks[7]?.visibility >= 0.2 ? toPoint(landmarks[7]) : null;
  const rightEar = landmarks[8]?.visibility >= 0.2 ? toPoint(landmarks[8]) : null;
  const earDistance = leftEar && rightEar
    ? Math.hypot(leftEar.x - rightEar.x, leftEar.y - rightEar.y)
    : scale * 0.12;
  const faceWidth = clamp(earDistance * 1.15, scale * 0.08, scale * 0.18);
  const faceHeight = faceWidth * 1.25;
  const eyeCenterX = leftEye && rightEye ? (leftEye.x + rightEye.x) / 2 : faceCenter.x;
  const yaw = clamp((faceCenter.x - eyeCenterX) / Math.max(faceWidth * 0.25, 1), -0.85, 0.85);
  const faceColor = depthColor(stroke, 0, alpha);
  const leftEyeX = leftEye ? leftEye.x : faceCenter.x - faceWidth * (0.2 - yaw * 0.08);
  const rightEyeX = rightEye ? rightEye.x : faceCenter.x + faceWidth * (0.2 + yaw * 0.08);
  const eyeY = leftEye && rightEye ? (leftEye.y + rightEye.y) / 2 : faceCenter.y - faceHeight * 0.08;
  const mouthX = leftMouth && rightMouth ? (leftMouth.x + rightMouth.x) / 2 : faceCenter.x + yaw * faceWidth * 0.12;
  const mouthY = leftMouth && rightMouth ? (leftMouth.y + rightMouth.y) / 2 : faceCenter.y + faceHeight * 0.24;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = faceColor;
  ctx.fillStyle = 'rgba(8, 8, 16, 0.42)';
  ctx.lineWidth = Math.max(1.2, scale * 0.006);
  ctx.beginPath();
  ctx.ellipse(faceCenter.x - yaw * faceWidth * 0.08, faceCenter.y, faceWidth * (0.5 - Math.abs(yaw) * 0.12), faceHeight * 0.5, yaw * 0.18, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = faceColor;
  ctx.beginPath();
  ctx.arc(leftEyeX, eyeY, Math.max(1.2, faceWidth * 0.04 * (1 + yaw * 0.22)), 0, Math.PI * 2);
  ctx.arc(rightEyeX, eyeY, Math.max(1.2, faceWidth * 0.04 * (1 - yaw * 0.22)), 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.ellipse(mouthX, mouthY, faceWidth * 0.15, faceHeight * 0.04, yaw * 0.2, 0, Math.PI);
  ctx.stroke();
  ctx.restore();
}

function fillTorso(
  landmarks: PoseLandmark[],
  toPoint: (landmark: PoseLandmark) => PoseLandmark,
  alpha: number,
  stroke: string,
) {
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];
  const leftHip = landmarks[23];
  const rightHip = landmarks[24];
  if (
    !leftShoulder ||
    !rightShoulder ||
    !leftHip ||
    !rightHip ||
    leftShoulder.visibility < 0.2 ||
    rightShoulder.visibility < 0.2 ||
    leftHip.visibility < 0.2 ||
    rightHip.visibility < 0.2
  ) return;

  const ls = toPoint(leftShoulder);
  const rs = toPoint(rightShoulder);
  const rh = toPoint(rightHip);
  const lh = toPoint(leftHip);

  ctx.save();
  ctx.globalAlpha = alpha * 0.22;
  ctx.fillStyle = stroke;
  ctx.beginPath();
  ctx.moveTo(ls.x, ls.y);
  ctx.lineTo(rs.x, rs.y);
  ctx.lineTo(rh.x, rh.y);
  ctx.lineTo(lh.x, lh.y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawSkeleton(landmarks: PoseLandmark[], alpha: number, stroke: string) {
  const referenceZ = depthReference(landmarks);

  ctx.save();
  fillTorso(landmarks, toCanvas, alpha, stroke);

  for (const [a, b] of skeletonConnections) {
    const first = landmarks[a];
    const second = landmarks[b];
    if (first.visibility < 0.2 || second.visibility < 0.2) continue;
    const p1 = toCanvas(first);
    const p2 = toCanvas(second);
    const depth = (depthAmount(first, referenceZ) + depthAmount(second, referenceZ)) / 2;
    const lineAlpha = clamp(alpha * (0.88 + depth * 0.12), 0.45, 1);
    ctx.strokeStyle = depthColor(stroke, depth, lineAlpha);
    ctx.lineWidth = Math.max(2.8, 3.2 + Math.max(0, depth) * 1.8);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }

  ctx.restore();

  ctx.save();
  for (const landmark of landmarks) {
    if (landmark.visibility < 0.2) continue;
    const index = landmarks.indexOf(landmark);
    if (index >= 0 && index <= 10) continue;
    const point = toCanvas(landmark);
    const depth = depthAmount(landmark, referenceZ);
    const radius = 5;
    ctx.fillStyle = depthColor(stroke, depth, clamp(alpha * (0.9 + depth * 0.08), 0.45, 1));
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  drawFaceGlyph(landmarks, currentFaceLandmarks, toCanvas, alpha, stroke, Math.min(canvas.width, canvas.height));
}

function drawSkeletonInPanel(
  landmarks: PoseLandmark[],
  faceLandmarks: PoseLandmark[],
  panelX: number,
  panelY: number,
  panelWidth: number,
  panelHeight: number,
  alpha: number,
  stroke: string,
) {
  const sourceAspect = video.videoWidth && video.videoHeight
    ? video.videoWidth / video.videoHeight
    : 4 / 3;
  const panelAspect = panelWidth / panelHeight;
  const drawWidth = panelAspect > sourceAspect ? panelHeight * sourceAspect : panelWidth;
  const drawHeight = panelAspect > sourceAspect ? panelHeight : panelWidth / sourceAspect;
  const offsetX = panelX + (panelWidth - drawWidth) / 2;
  const offsetY = panelY + (panelHeight - drawHeight) / 2;

  const toPanel = (landmark: PoseLandmark) => ({
    x: offsetX + landmark.x * drawWidth,
    y: offsetY + landmark.y * drawHeight,
    z: landmark.z,
    visibility: landmark.visibility,
  });
  const referenceZ = depthReference(landmarks);
  const baseSize = Math.min(panelWidth, panelHeight);

  ctx.save();
  ctx.beginPath();
  ctx.rect(panelX, panelY, panelWidth, panelHeight);
  ctx.clip();
  fillTorso(landmarks, toPanel, alpha, stroke);

  for (const [a, b] of skeletonConnections) {
    const first = landmarks[a];
    const second = landmarks[b];
    if (first.visibility < 0.2 || second.visibility < 0.2) continue;
    const p1 = toPanel(first);
    const p2 = toPanel(second);
    const depth = (depthAmount(first, referenceZ) + depthAmount(second, referenceZ)) / 2;
    const lineAlpha = clamp(alpha * (0.86 + depth * 0.14), 0.42, 1);
    ctx.strokeStyle = depthColor(stroke, depth, lineAlpha);
    ctx.lineWidth = Math.max(1.8, baseSize * 0.014 + Math.max(0, depth) * baseSize * 0.008);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }

  for (const landmark of landmarks) {
    if (landmark.visibility < 0.2) continue;
    const index = landmarks.indexOf(landmark);
    if (index >= 0 && index <= 10) continue;
    const point = toPanel(landmark);
    const depth = depthAmount(landmark, referenceZ);
    const radius = Math.max(2, baseSize * 0.018);
    ctx.fillStyle = depthColor(stroke, depth, clamp(alpha * (0.9 + depth * 0.08), 0.42, 1));
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  drawFaceGlyph(landmarks, faceLandmarks, toPanel, alpha, stroke, baseSize);

  ctx.restore();
}

function drawLivePose() {
  if (!currentLandmarks) return;
  drawSkeleton(currentLandmarks, 0.88, 'rgba(255,255,255,0.96)');
}

function canvasTopInset() {
  const overlay = document.querySelector('.overlay') as HTMLElement | null;
  if (!overlay) return 20;
  const rect = overlay.getBoundingClientRect();
  return clamp(rect.bottom + 14, 20, Math.max(20, canvas.height - 260));
}

function drawOriginalPlayback(elapsedMilliseconds: number) {
  if (recordedFrames.length < 2 || !playback) return;

  const loopTime = elapsedMilliseconds % playbackDuration;
  const frame = sampleFrameAt(loopTime);
  if (!frame) return;

  const margin = 36;
  const topInset = canvasTopInset();
  const panelWidth = canvas.width - margin * 2;
  const panelHeight = canvas.height - topInset - margin;

  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 1;
  ctx.strokeRect(margin, topInset, panelWidth, panelHeight);
  ctx.fillStyle = 'rgba(255,255,255,0.86)';
  ctx.font = '16px sans-serif';
  ctx.fillText('Original replay', margin + 14, topInset + 26);
  ctx.restore();

  drawSkeletonInPanel(frame.landmarks, frame.faceLandmarks, margin, topInset, panelWidth, panelHeight, 0.96, 'rgba(255,255,255,0.96)');
}

function drawDanceOverlay(elapsedMilliseconds: number) {
  if (recordedFrames.length < 2 || !playback) return;

  const loopTime = elapsedMilliseconds % playbackDuration;
  const originalFrame = sampleFrameAt(loopTime);
  if (!originalFrame) return;

  const baseLandmarks = originalFrame.landmarks.map((landmark) => ({ ...landmark }));
  const baseFaceLandmarks = originalFrame.faceLandmarks.map((landmark) => ({ ...landmark }));
  const variations = getActivePanelRules();
  const margin = 20;
  const topInset = canvasTopInset();
  const gap = 16;
  const rowGap = 12;
  const rowCount = variations.length;
  const panelHeight = (canvas.height - topInset - margin - rowGap * (rowCount - 1)) / rowCount;
  const totalWidth = canvas.width - margin * 2 - gap * 3;
  // Cap each panel's width relative to its height so panels stay close to the
  // aspect ratio of the person inside them instead of stretching into flat,
  // mostly-empty strips when many rows are stacked into a short canvas.
  const maxPanelAspect = 1.6;
  const originalPanelWidth = Math.min(totalWidth * 0.18, panelHeight * maxPanelAspect);
  const explanationPanelWidth = Math.min(totalWidth * 0.18, panelHeight * maxPanelAspect * 1.3);
  const motionPanelWidth = Math.min((totalWidth - originalPanelWidth - explanationPanelWidth) / 2, panelHeight * maxPanelAspect);
  const usedWidth = originalPanelWidth + explanationPanelWidth + motionPanelWidth * 2 + gap * 3;
  const leftPanelX = margin + Math.max(0, (canvas.width - margin * 2 - usedWidth) / 2);
  const centerPanelX = leftPanelX + originalPanelWidth + gap;
  const rightPanelX = centerPanelX + motionPanelWidth + gap;
  const explanationPanelX = rightPanelX + motionPanelWidth + gap;

  const drawPanel = (landmarks: PoseLandmark[], faceLandmarks: PoseLandmark[], x: number, y: number, width: number, alpha: number, stroke: string) => {
    drawSkeletonInPanel(landmarks, faceLandmarks, x, y, width, panelHeight, alpha, stroke);
  };

  const drawOverlapPanel = (transformedLandmarks: PoseLandmark[], transformedFaceLandmarks: PoseLandmark[], x: number, y: number) => {
    drawPanel(baseLandmarks, baseFaceLandmarks, x, y, motionPanelWidth, 0.7, 'rgba(255,255,255,0.95)');
    drawPanel(transformedLandmarks, transformedFaceLandmarks, x, y, motionPanelWidth, 0.72, 'rgba(92, 214, 255, 0.96)');
  };

  const drawArrow = (fromX: number, fromY: number, toX: number, toY: number, color: string) => {
    const angle = Math.atan2(toY - fromY, toX - fromX);
    const headLength = 8;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(toX - Math.cos(angle - Math.PI / 6) * headLength, toY - Math.sin(angle - Math.PI / 6) * headLength);
    ctx.lineTo(toX - Math.cos(angle + Math.PI / 6) * headLength, toY - Math.sin(angle + Math.PI / 6) * headLength);
    ctx.closePath();
    ctx.fill();
  };

  const drawMiniStick = (centerX: number, centerY: number, scale: number, color: string, alpha: number, lean = 0) => {
    const headY = centerY - scale * 0.42;
    const shoulderY = centerY - scale * 0.18;
    const hipY = centerY + scale * 0.1;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(1, scale * 0.035);
    ctx.beginPath();
    ctx.arc(centerX + lean * 0.4, headY, scale * 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(centerX + lean * 0.2, shoulderY);
    ctx.lineTo(centerX, hipY);
    ctx.moveTo(centerX - scale * 0.18 + lean, shoulderY);
    ctx.lineTo(centerX + scale * 0.18 + lean, shoulderY);
    ctx.moveTo(centerX - scale * 0.18 + lean, shoulderY);
    ctx.lineTo(centerX - scale * 0.3 + lean, centerY + scale * 0.02);
    ctx.moveTo(centerX + scale * 0.18 + lean, shoulderY);
    ctx.lineTo(centerX + scale * 0.3 + lean, centerY + scale * 0.02);
    ctx.moveTo(centerX, hipY);
    ctx.lineTo(centerX - scale * 0.2, centerY + scale * 0.38);
    ctx.moveTo(centerX, hipY);
    ctx.lineTo(centerX + scale * 0.2, centerY + scale * 0.38);
    ctx.stroke();
    ctx.restore();
  };

  const drawExplanationPanel = (x: number, y: number, rule: VariationRule) => {
    const padding = 10;
    const top = y + padding;
    const bottom = y + panelHeight - padding;
    const midY = y + panelHeight * 0.56;
    const leftX = x + explanationPanelWidth * 0.3;
    const rightX = x + explanationPanelWidth * 0.68;
    const scale = Math.min(explanationPanelWidth, panelHeight) * 0.48;
    const notesByKind: Record<VariationKind, string[]> = {
      wave: ['Sway', 'Lift', 'Offset'],
      upperPull: ['Upper', 'Pull', 'Lower hold'],
      centerRipple: ['Center', 'Ripple', 'Compress'],
      floatDrift: ['Float', 'Drift', 'Time lag'],
      gestureAccent: ['Anticipate', 'Accent', 'Follow'],
      rhythmLock: ['Beat grid', `${activeBpm} BPM`, 'Snap'],
    };
    const notes = notesByKind[rule.kind];

    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(x + 4, y + 4, explanationPanelWidth - 8, panelHeight - 8);
    ctx.strokeStyle = 'rgba(92, 214, 255, 0.42)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 4, y + 4, explanationPanelWidth - 8, panelHeight - 8);

    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.font = '12px sans-serif';
    ctx.fillText(`${rule.name} rule`, x + padding, top + 2);

    drawMiniStick(leftX, midY, scale, 'rgba(255,255,255,0.95)', 0.85);
    drawMiniStick(rightX, midY + (rule.kind === 'floatDrift' ? -5 : 0), scale, 'rgba(92, 214, 255, 0.96)', 0.9, rule.kind === 'upperPull' ? 8 : rule.kind === 'centerRipple' ? -3 : 4);
    drawArrow(leftX + scale * 0.34, midY, rightX - scale * 0.3, midY + (rule.kind === 'floatDrift' ? -8 : 0), 'rgba(92, 214, 255, 0.86)');

    if (rule.kind === 'wave') {
      drawArrow(rightX, midY - scale * 0.48, rightX + 20, midY - scale * 0.48, 'rgba(92, 214, 255, 0.78)');
      drawArrow(rightX + 14, midY - scale * 0.1, rightX + 14, midY - scale * 0.27, 'rgba(92, 214, 255, 0.78)');
    } else if (rule.kind === 'upperPull') {
      drawArrow(rightX - 12, midY - scale * 0.18, rightX + 24, midY - scale * 0.22, 'rgba(92, 214, 255, 0.78)');
    } else if (rule.kind === 'centerRipple') {
      drawArrow(rightX - 38, midY + 10, rightX - 16, midY + 5, 'rgba(92, 214, 255, 0.78)');
      drawArrow(rightX + 38, midY + 10, rightX + 16, midY + 5, 'rgba(92, 214, 255, 0.78)');
    } else if (rule.kind === 'rhythmLock') {
      for (let beat = 0; beat < 4; beat += 1) {
        const beatX = rightX - 36 + beat * 24;
        ctx.strokeStyle = 'rgba(92, 214, 255, 0.62)';
        ctx.beginPath();
        ctx.moveTo(beatX, midY + scale * 0.34);
        ctx.lineTo(beatX, midY + scale * 0.5);
        ctx.stroke();
      }
    } else {
      drawArrow(rightX - 8, midY + 18, rightX + 18, midY - 18, 'rgba(92, 214, 255, 0.78)');
    }

    ctx.fillStyle = 'rgba(255,255,255,0.74)';
    ctx.font = '11px sans-serif';
    ctx.fillText(notes[0], x + padding, bottom - 22);
    ctx.fillText(notes[1], x + padding, bottom - 10);
    ctx.fillText(notes[2], x + padding + Math.min(88, explanationPanelWidth * 0.48), bottom - 10);
    ctx.restore();
  };

  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();

  for (const [index, variation] of variations.entries()) {
    const panelY = topInset + index * (panelHeight + rowGap);
    const animatedShift = variation.kind === 'wave'
      ? Math.sin(elapsedMilliseconds / 500) * 10 + Math.cos(elapsedMilliseconds / 700) * 8
      : variation.kind === 'upperPull'
        ? Math.sin(elapsedMilliseconds / 680) * 18
        : variation.kind === 'centerRipple'
          ? Math.sin(elapsedMilliseconds / 360) * 32
          : variation.kind === 'floatDrift'
            ? Math.cos(elapsedMilliseconds / 820) * 24
            : 0;
    const rawShiftedTime = (loopTime + variation.timeShift + animatedShift + playbackDuration) % playbackDuration;
    const shiftedTime = variation.kind === 'gestureAccent'
      ? gestureAccentTime(rawShiftedTime)
      : variation.kind === 'rhythmLock'
        ? rhythmLockTime(rawShiftedTime)
        : rawShiftedTime;
    const sourceFrame = sampleFrameAt(shiftedTime);
    if (!sourceFrame) continue;
    const transformedLandmarks = transformPoseForDance(sourceFrame, elapsedMilliseconds, index, variation.kind, variation.strength);
    for (let headIndex = 0; headIndex <= 10; headIndex += 1) {
      if (baseLandmarks[headIndex]) transformedLandmarks[headIndex] = { ...baseLandmarks[headIndex] };
    }
    const transformedFaceLandmarks = baseFaceLandmarks.map((landmark) => ({ ...landmark }));

    drawOverlapPanel(transformedLandmarks, transformedFaceLandmarks, centerPanelX, panelY);
    drawPanel(transformedLandmarks, transformedFaceLandmarks, rightPanelX, panelY, motionPanelWidth, 0.96, 'rgba(92, 214, 255, 0.96)');
    drawExplanationPanel(explanationPanelX, panelY, variation);

    if (index === 0) {
      drawPanel(baseLandmarks, baseFaceLandmarks, leftPanelX, panelY, originalPanelWidth, 0.95, 'rgba(255,255,255,0.95)');
    }

    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.86)';
    ctx.font = '13px sans-serif';
    if (index === 0) ctx.fillText('Original', leftPanelX + 10, panelY + 20);
    ctx.fillText(`${variation.name} overlap`, centerPanelX + 10, panelY + 20);
    ctx.fillText(`${variation.name} transformed`, rightPanelX + 10, panelY + 20);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = 'rgba(92, 214, 255, 0.42)';
    ctx.lineWidth = 1;
    if (index === 0) ctx.strokeRect(leftPanelX + 4, panelY + 4, originalPanelWidth - 8, panelHeight - 8);
    ctx.strokeRect(centerPanelX + 4, panelY + 4, motionPanelWidth - 8, panelHeight - 8);
    ctx.strokeRect(rightPanelX + 4, panelY + 4, motionPanelWidth - 8, panelHeight - 8);
    ctx.restore();
  }

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(centerPanelX - gap / 2, topInset);
  ctx.lineTo(centerPanelX - gap / 2, canvas.height - margin);
  ctx.moveTo(rightPanelX - gap / 2, topInset);
  ctx.lineTo(rightPanelX - gap / 2, canvas.height - margin);
  ctx.moveTo(explanationPanelX - gap / 2, topInset);
  ctx.lineTo(explanationPanelX - gap / 2, canvas.height - margin);
  ctx.stroke();
  ctx.restore();
}

function drawCameraBackground() {
  if (video.readyState >= 2) {
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  }
}

function drawFrame() {
  root?.classList.toggle('is-playing', playback);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(8, 8, 16, 0.24)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (playback) {
    const elapsed = performance.now() - playbackStart;
    if (playbackMode === 'original') {
      drawOriginalPlayback(elapsed);
    } else {
      drawDanceOverlay(elapsed);
    }
  } else {
    drawCameraBackground();
    drawLivePose();

    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-120, 0);
    ctx.lineTo(120, 0);
    ctx.moveTo(0, -120);
    ctx.lineTo(0, 120);
    ctx.stroke();
    ctx.restore();
  }

  requestAnimationFrame(drawFrame);
}

resizeCanvas();
loadSavedRecordings();
loadSavedRuleSets();
refreshCameraDevices();
requestAnimationFrame(drawFrame);
